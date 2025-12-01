require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. KEEP-ALIVE SERVER (Mandatory for Cloud) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🚀 Bot is Active & Listening...'));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// --- 2. CONFIGURATION ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const sessionString = process.env.SESSION_STRING; 
const adminId = process.env.ADMIN_ID; 

// We use a Set instead of an Array for performance with large files
let targetNumbers = new Set(); 

// --- 3. DATABASE SYSTEM (Saved Messages Backup) ---
async function backupDatabase(client) {
    try {
        // Convert Set back to Array for storage
        const data = JSON.stringify([...targetNumbers], null, 2);
        const buffer = Buffer.from(data, 'utf8');
        buffer.name = "database_backup.json"; 
        
        // Delete previous backup message to keep chat clean (optional, hard to do reliably without ID)
        await client.sendMessage("me", {
            message: `📂 #DB_BACKUP\nCount: ${targetNumbers.size}\n(Do not delete)`,
            file: buffer,
            forceDocument: true
        });
        console.log(`💾 Backed up ${targetNumbers.size} numbers.`);
    } catch (e) {
        console.error("Backup failed:", e);
    }
}

async function restoreDatabase(client) {
    try {
        console.log("🔄 Searching for backups...");
        const result = await client.getMessages("me", { search: "#DB_BACKUP", limit: 1 });
        
        if (result && result.length > 0 && result[0].media) {
            const buffer = await client.downloadMedia(result[0], {});
            const loadedArray = JSON.parse(buffer.toString('utf8'));
            targetNumbers = new Set(loadedArray); // Convert back to Set
            console.log(`✅ Restored ${targetNumbers.size} numbers.`);
        } else {
            console.log("⚠️ No backup found. Starting fresh.");
        }
    } catch (e) {
        console.error("Restore failed:", e);
    }
}

// --- 4. OPTIMIZED PARSERS ---

// Extracts ANY number that is 7 digits or longer from a text file
function extractNumbersFromText(textContent) {
    // Looks for sequences of digits (with optional +) that are 7-15 chars long
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    
    // Clean them (remove +) and return
    return matches.map(num => num.replace(/\+/g, ''));
}

// Optimized Matcher for Masked Numbers
function isMatch(msgNumber) {
    const cleanMsgNumber = msgNumber.replace(/[^0-9*]/g, ''); 

    // 1. Direct Match (Fastest)
    if (targetNumbers.has(cleanMsgNumber)) return cleanMsgNumber;

    // 2. Masked Match (Slower, requires iteration)
    if (cleanMsgNumber.includes('*')) {
        const parts = cleanMsgNumber.split('*').filter(p => p.length > 0);
        if (parts.length < 1) return false;

        const prefix = parts[0];
        const suffix = parts[parts.length - 1];

        // We iterate through our Set. 
        // Note: With 100k+ numbers, this takes milliseconds.
        for (const myNum of targetNumbers) {
            if (myNum.startsWith(prefix) && myNum.endsWith(suffix)) {
                return myNum; // Return the real number we found
            }
        }
    }
    return null;
}

// --- 5. MAIN LOGIC ---
(async () => {
    if (!sessionString) {
        console.error("❌ ERROR: SESSION_STRING missing in Env Vars!");
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({ onError: (err) => console.log(err) });
    console.log("✅ Logged in!");
    
    await restoreDatabase(client);

    // --- MONITORING (ALL Groups/Channels/DMs) ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";

        // Quick filter to save CPU
        if (!text.toLowerCase().includes("otp") && !text.toLowerCase().includes("code")) return;

        try {
            // Regex to find OTP and Number
            const otpMatch = text.match(/(?:OTP|Code)\s*[:\-]\s*([\d]{3}[-\s]?[\d]{3})/i);
            const numMatch = text.match(/Number\s*[:\-]\s*([+\d*]+)/i);

            if (otpMatch && numMatch) {
                const capturedOtp = otpMatch[1];
                const capturedNumber = numMatch[1];

                // Check Database
                const matchedRealNumber = isMatch(capturedNumber);

                if (matchedRealNumber) {
                    console.log(`🎯 FOUND MATCH: ${matchedRealNumber}`);
                    
                    if (adminId) {
                        await client.sendMessage(adminId, { 
                            message: `🚨 **MATCH FOUND!**\n\n` +
                                     `📞 Real: \`${matchedRealNumber}\`\n` +
                                     `📨 Masked: \`${capturedNumber}\`\n` +
                                     `🔑 OTP: \`${capturedOtp}\`\n`
                        });
                        await client.sendMessage(adminId, { message: capturedOtp });
                    }
                }
            }
        } catch (e) {
            console.error("Parse Error:", e);
        }
    }, new NewMessage({ incoming: true })); // Listen to EVERYTHING incoming

    // --- COMMANDS ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";

        // /join https://t.me/...
        if (text.startsWith("/join ")) {
            try {
                const link = text.split(" ")[1];
                let hash = link.replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                await message.reply({ message: "✅ Joined!" });
            } catch (e) {
                await message.reply({ message: "❌ " + (e.errorMessage || e.message) });
            }
        }

        // /save (Reply to ANY text file)
        if (text === "/save" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                await message.reply({ message: "⏳ Downloading & Processing..." });
                try {
                    const buffer = await client.downloadMedia(replyMsg, {});
                    const content = buffer.toString('utf8');
                    
                    const newNumbers = extractNumbersFromText(content);
                    
                    if (newNumbers.length > 0) {
                        const beforeSize = targetNumbers.size;
                        
                        // Add to Set (auto-removes duplicates)
                        newNumbers.forEach(n => targetNumbers.add(n));
                        
                        const addedCount = targetNumbers.size - beforeSize;
                        await backupDatabase(client);
                        
                        await message.reply({ 
                            message: `✅ **Success!**\n` +
                                     `📥 Found in file: ${newNumbers.length}\n` +
                                     `🆕 Actually added: ${addedCount}\n` +
                                     `📚 Total DB: ${targetNumbers.size}` 
                        });
                    } else {
                        await message.reply({ message: "❌ No valid numbers found." });
                    }
                } catch (e) {
                    await message.reply({ message: "❌ Error reading file." });
                    console.error(e);
                }
            }
        }

        // /delete (Reply to file)
        if (text === "/delete" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                const buffer = await client.downloadMedia(replyMsg, {});
                const delNums = extractNumbersFromText(buffer.toString('utf8'));
                
                const beforeSize = targetNumbers.size;
                delNums.forEach(n => targetNumbers.delete(n));
                const afterSize = targetNumbers.size;
                
                await backupDatabase(client);
                await message.reply({ message: `🗑 Removed: ${beforeSize - afterSize}` });
            }
        }
    }, new NewMessage({ outgoing: true }));
})();
