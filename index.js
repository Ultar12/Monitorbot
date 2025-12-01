require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. KEEP-ALIVE SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is Active and Listening...'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// --- 2. CONFIGURATION ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const sessionString = process.env.SESSION_STRING; 
const adminId = process.env.ADMIN_ID; 

// ALLOWED USERS CONFIG
const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// Database Storage
let targetNumbers = new Set(); 

// --- 3. DATABASE SYSTEM ---
async function backupDatabase(client) {
    try {
        const data = JSON.stringify([...targetNumbers], null, 2);
        const buffer = Buffer.from(data, 'utf8');
        buffer.name = "database_backup.json"; 
        
        await client.sendMessage("me", {
            message: "DB_BACKUP\n(Do not delete this message)",
            file: buffer,
            forceDocument: true
        });
        console.log(`Backed up ${targetNumbers.size} numbers.`);
    } catch (e) {
        console.error("Backup failed:", e);
    }
}

async function restoreDatabase(client) {
    try {
        console.log("Searching for backups...");
        const result = await client.getMessages("me", { search: "DB_BACKUP", limit: 1 });
        
        if (result && result.length > 0 && result[0].media) {
            const buffer = await client.downloadMedia(result[0], {});
            const loadedArray = JSON.parse(buffer.toString('utf8'));
            targetNumbers = new Set(loadedArray);
            console.log(`Restored ${targetNumbers.size} numbers.`);
        } else {
            console.log("No backup found. Starting fresh.");
        }
    } catch (e) {
        console.error("Restore failed:", e);
    }
}

// --- 4. PARSERS ---
function extractNumbersFromText(textContent) {
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    return matches.map(num => num.replace(/\+/g, ''));
}

function isMatch(msgNumber) {
    const cleanMsgNumber = msgNumber.replace(/[^0-9*]/g, ''); 
    
    // Direct match
    if (targetNumbers.has(cleanMsgNumber)) return cleanMsgNumber;

    // Masked match (e.g. 234***567)
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
        console.error("ERROR: SESSION_STRING missing in Env Vars!");
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({ onError: (err) => console.log(err) });
    console.log("Logged in successfully!");
    
    await restoreDatabase(client);

    // --- MONITORING LOGIC ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";

        // Minimal filter to reduce CPU usage, but generic enough for new format
        // We look for any text that might contain a masked number OR an OTP format
        if (text.length < 5) return;

        try {
            // Regex Explanations:
            // OTP: Looks for "123-456" OR "123 456" OR "Code 123456"
            // It searches for isolated 6-digit patterns or 3-dash-3 patterns
            const otpRegex = /(?:\b\d{3}[-\s]\d{3}\b|\b\d{6}\b)/;
            
            // Number: Looks for digits mixed with asterisks (e.g., 234***567)
            const numRegex = /([0-9]+\*+[0-9]+)/;

            const otpMatch = text.match(otpRegex);
            const numMatch = text.match(numRegex);

            if (otpMatch && numMatch) {
                const capturedOtp = otpMatch[0].trim(); // "105-354"
                const capturedNumber = numMatch[0].trim(); // "234***3560"

                const matchedRealNumber = isMatch(capturedNumber);

                if (matchedRealNumber) {
                    if (adminId) {
                        // Send simple alert to admin
                        await client.sendMessage(adminId, { 
                            message: `MATCH FOUND\n\n` +
                                     `My Number: ${matchedRealNumber}\n` +
                                     `Msg Number: ${capturedNumber}\n` +
                                     `OTP Below:`
                        });
                        
                        // Send OTP in monospace format for one-tap copy
                        await client.sendMessage(adminId, { 
                            message: `\`${capturedOtp}\``,
                            parseMode: "markdown"
                        });
                    }
                }
            }
        } catch (e) {
            console.error("Parse Error:", e);
        }
    }, new NewMessage({ incoming: true })); 

    // --- COMMANDS ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const senderId = message.senderId ? Number(message.senderId) : null;
        
        const isMe = message.out;
        const isAllowedFriend = allowedUsers.includes(senderId);

        if (!isMe && !isAllowedFriend) return; 

        const text = message.text || "";

        // /start
        if (text === "/start") {
            await message.reply({ 
                message: "Bot is Online.\n\n" +
                         "Commands:\n" +
                         "/save - Reply to a file to add numbers\n" +
                         "/delete - Reply to a file to remove numbers\n" +
                         "/clear - Delete ALL numbers from database\n" +
                         "/join <link> - Join a group\n\n" +
                         `Current Database Size: ${targetNumbers.size}`
            });
        }

        // /join
        if (text.startsWith("/join ")) {
            try {
                const link = text.split(" ")[1];
                let hash = link.replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                await message.reply({ message: "Joined successfully." });
            } catch (e) {
                await message.reply({ message: "Failed: " + (e.errorMessage || e.message) });
            }
        }

        // /save
        if (text === "/save" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                await message.reply({ message: "Processing file..." });
                try {
                    const buffer = await client.downloadMedia(replyMsg, {});
                    const content = buffer.toString('utf8');
                    const newNumbers = extractNumbersFromText(content);
                    
                    if (newNumbers.length > 0) {
                        newNumbers.forEach(n => targetNumbers.add(n));
                        await backupDatabase(client);
                        await message.reply({ message: `Success. Added ${newNumbers.length} numbers.\nTotal: ${targetNumbers.size}` });
                    } else {
                        await message.reply({ message: "No valid numbers found." });
                    }
                } catch (e) {
                    await message.reply({ message: "Error reading file." });
                }
            }
        }

        // /delete
        if (text === "/delete" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                const buffer = await client.downloadMedia(replyMsg, {});
                const delNums = extractNumbersFromText(buffer.toString('utf8'));
                
                const beforeSize = targetNumbers.size;
                delNums.forEach(n => targetNumbers.delete(n));
                
                await backupDatabase(client);
                await message.reply({ message: `Removed: ${beforeSize - targetNumbers.size}` });
            }
        }

        // /clear
        if (text === "/clear") {
            const size = targetNumbers.size;
            targetNumbers.clear();
            await backupDatabase(client);
            await message.reply({ message: `Database cleared. Removed ${size} numbers.` });
        }

    }, new NewMessage({ incoming: true, outgoing: true })); 

})();
