require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. KEEP-ALIVE SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🚀 Bot is Active & Listening...'));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// --- 2. CONFIGURATION ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const sessionString = process.env.SESSION_STRING; 
const adminId = process.env.ADMIN_ID; 

// CONFIGURING ALLOWED USERS
// We read a comma-separated list from Env Vars (e.g. "12345, 67890")
const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

console.log(`👥 Allowed Users: You + ${allowedUsers.length} friends`);

// We use a Set instead of an Array for performance
let targetNumbers = new Set(); 

// --- 3. DATABASE SYSTEM ---
async function backupDatabase(client) {
    try {
        const data = JSON.stringify([...targetNumbers], null, 2);
        const buffer = Buffer.from(data, 'utf8');
        buffer.name = "database_backup.json"; 
        
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
            targetNumbers = new Set(loadedArray);
            console.log(`✅ Restored ${targetNumbers.size} numbers.`);
        } else {
            console.log("⚠️ No backup found. Starting fresh.");
        }
    } catch (e) {
        console.error("Restore failed:", e);
    }
}

// --- 4. OPTIMIZED PARSERS ---
function extractNumbersFromText(textContent) {
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    return matches.map(num => num.replace(/\+/g, ''));
}

function isMatch(msgNumber) {
    const cleanMsgNumber = msgNumber.replace(/[^0-9*]/g, ''); 
    if (targetNumbers.has(cleanMsgNumber)) return cleanMsgNumber;

    if (cleanMsgNumber.includes('*')) {
        const parts = cleanMsgNumber.split('*').filter(p => p.length > 0);
        if (parts.length < 1) return false;

        const prefix = parts[0];
        const suffix = parts[parts.length - 1];

        for (const myNum of targetNumbers) {
            if (myNum.startsWith(prefix) && myNum.endsWith(suffix)) {
                return myNum;
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

    // --- MONITORING (Incoming OTPs) ---
    // This listens to EVERYTHING incoming to detect OTPs
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";

        if (!text.toLowerCase().includes("otp") && !text.toLowerCase().includes("code")) return;

        try {
            const otpMatch = text.match(/(?:OTP|Code)\s*[:\-]\s*([\d]{3}[-\s]?[\d]{3})/i);
            const numMatch = text.match(/Number\s*[:\-]\s*([+\d*]+)/i);

            if (otpMatch && numMatch) {
                const capturedOtp = otpMatch[1];
                const capturedNumber = numMatch[1];
                const matchedRealNumber = isMatch(capturedNumber);

                if (matchedRealNumber) {
                    // Alert the Main Admin
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
    }, new NewMessage({ incoming: true })); 

    // --- COMMANDS (/join, /save, /delete) ---
    // Now listens to incoming AND outgoing so friends can use it
    client.addEventHandler(async (event) => {
        const message = event.message;
        const senderId = message.senderId ? Number(message.senderId) : null;
        
        // --- SECURITY CHECK ---
        // Allow if: 1. It is YOU (outgoing) OR 2. Sender is in the ALLOWED list
        const isMe = message.out;
        const isAllowedFriend = allowedUsers.includes(senderId);

        if (!isMe && !isAllowedFriend) return; // Ignore everyone else
        // ----------------------

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
                await message.reply({ message: "⏳ Processing file..." });
                try {
                    const buffer = await client.downloadMedia(replyMsg, {});
                    const content = buffer.toString('utf8');
                    const newNumbers = extractNumbersFromText(content);
                    
                    if (newNumbers.length > 0) {
                        newNumbers.forEach(n => targetNumbers.add(n));
                        await backupDatabase(client);
                        await message.reply({ message: `✅ **Added ${newNumbers.length} numbers.**\n📚 DB Size: ${targetNumbers.size}` });
                    } else {
                        await message.reply({ message: "❌ No valid numbers found." });
                    }
                } catch (e) {
                    await message.reply({ message: "❌ Error reading file." });
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
                
                await backupDatabase(client);
                await message.reply({ message: `🗑 Removed: ${beforeSize - targetNumbers.size}` });
            }
        }
    }, new NewMessage({ incoming: true, outgoing: true })); // Listen to both sides

})();
