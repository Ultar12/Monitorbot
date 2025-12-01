require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER (Keeps Bot Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is Running...'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- 2. CONFIG ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const sessionString = process.env.SESSION_STRING; 
const adminId = process.env.ADMIN_ID; 

const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

let targetNumbers = new Set(); 

// --- 3. DATABASE (Saved Messages) ---
async function backupDatabase(client) {
    try {
        const data = JSON.stringify([...targetNumbers], null, 2);
        const buffer = Buffer.from(data, 'utf8');
        buffer.name = "database_backup.json"; 
        
        await client.sendMessage("me", {
            message: "DB_BACKUP_DO_NOT_DELETE",
            file: buffer,
            forceDocument: true
        });
        console.log(`[BACKUP] Saved ${targetNumbers.size} numbers.`);
    } catch (e) {
        console.error("Backup Error:", e);
    }
}

async function restoreDatabase(client) {
    try {
        const result = await client.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
        if (result && result.length > 0 && result[0].media) {
            const buffer = await client.downloadMedia(result[0], {});
            const loadedArray = JSON.parse(buffer.toString('utf8'));
            targetNumbers = new Set(loadedArray);
            console.log(`[RESTORE] Loaded ${targetNumbers.size} numbers.`);
        } else {
            console.log("[INFO] No backup found. Database empty.");
        }
    } catch (e) {
        console.error("Restore Error:", e);
    }
}

// --- 4. PARSING LOGIC ---
function extractNumbersFromText(textContent) {
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    return matches.map(num => num.replace(/\+/g, ''));
}

// Checks if 'realNumber' matches 'maskedNumber'
function isMaskedMatch(realNumber, maskedNumber) {
    const cleanMasked = maskedNumber.replace(/[^0-9*]/g, ''); 
    
    // Direct match (if not masked)
    if (realNumber === cleanMasked) return true;

    // Masked match (e.g. 234***567)
    if (cleanMasked.includes('*')) {
        const parts = cleanMasked.split('*').filter(p => p.length > 0);
        if (parts.length < 1) return false;

        const prefix = parts[0];
        const suffix = parts[parts.length - 1];

        // Ensure the real number starts with prefix AND ends with suffix
        return realNumber.startsWith(prefix) && realNumber.endsWith(suffix);
    }
    return false;
}

// Scans text for OTPs and Numbers
function parseMessageForOtp(text) {
    if (!text || text.length < 5) return null;

    // OTP Regex: "123-456" OR "123 456" OR "Code 123456" OR "123456"
    // We look for 6 digits, optionally separated by dash/space
    const otpRegex = /(?:\b\d{3}[-\s]\d{3}\b|\b\d{6}\b)/;
    
    // Number Regex: Digits followed by * followed by digits (e.g., 234***567)
    // Matches "234***567" or "+234***567"
    const numRegex = /([0-9]+\*+[0-9]+)/;

    const otpMatch = text.match(otpRegex);
    const numMatch = text.match(numRegex);

    if (otpMatch && numMatch) {
        return {
            otp: otpMatch[0].trim(),
            number: numMatch[0].trim()
        };
    }
    return null;
}

// --- 5. MAIN ---
(async () => {
    if (!sessionString) {
        console.error("FATAL: SESSION_STRING is missing.");
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({ onError: (err) => console.log(err) });
    console.log("[START] Bot is logged in.");
    
    await restoreDatabase(client);

    // --- MONITORING (PASSIVE) ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";
        
        const data = parseMessageForOtp(text);
        
        if (data) {
            // Check if this masked number matches any number in our DB
            let foundRealNumber = null;
            
            for (const myNum of targetNumbers) {
                if (isMaskedMatch(myNum, data.number)) {
                    foundRealNumber = myNum;
                    break;
                }
            }

            if (foundRealNumber) {
                if (adminId) {
                    await client.sendMessage(adminId, { 
                        message: `[ALERT] MATCH FOUND\n\n` +
                                 `Real Num: ${foundRealNumber}\n` +
                                 `Masked: ${data.number}\n` +
                                 `OTP Below:`
                    });
                    // Send OTP in monospace for easy copying
                    await client.sendMessage(adminId, { 
                        message: `\`${data.otp}\``,
                        parseMode: "markdown"
                    });
                }
            }
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

        // --- /start ---
        if (text === "/start") {
            await message.reply({ 
                message: "SYSTEM ONLINE\n\n" +
                         "COMMANDS:\n" +
                         "/save - Reply to file to add numbers\n" +
                         "/delete - Reply to file to remove numbers\n" +
                         "/clear - Wipe database\n" +
                         "/s <number> - Search OTP for number\n" +
                         "/join <link> - Join group\n\n" +
                         `Database Size: ${targetNumbers.size}`
            });
        }

        // --- /s (SEARCH) ---
        if (text.startsWith("/s ")) {
            const queryNum = text.split(" ")[1];
            if (!queryNum) return await message.reply({ message: "[ERROR] Provide number. Ex: /s +23480..." });

            await message.reply({ message: `[SEARCHING] Scanning global history for ${queryNum}...` });

            try {
                // Search strategy: Search for last 4 digits (Suffix)
                const suffix = queryNum.replace(/\D/g, '').slice(-4);
                
                const result = await client.invoke(new Api.messages.SearchGlobal({
                    q: suffix,
                    filter: new Api.InputMessagesFilterEmpty(),
                    minDate: 0,
                    maxDate: 0,
                    offsetRate: 0,
                    offsetPeer: new Api.InputPeerEmpty(),
                    offsetId: 0,
                    limit: 50 // Check last 50 matches
                }));

                let found = false;

                if (result.messages) {
                    for (const msg of result.messages) {
                        const msgText = msg.message || "";
                        const data = parseMessageForOtp(msgText);

                        if (data) {
                            // Check if the masked number in message matches the full number provided
                            if (isMaskedMatch(queryNum.replace(/\D/g, ''), data.number)) {
                                await message.reply({ 
                                    message: `[FOUND]\nOTP: \`${data.otp}\`\nSource: ${data.number}`,
                                    parseMode: "markdown"
                                });
                                found = true;
                                break; // Stop after first match
                            }
                        }
                    }
                }

                if (!found) {
                    await message.reply({ message: "[RESULT] No OTP found for this number in recent history." });
                }

            } catch (e) {
                await message.reply({ message: "[ERROR] Search failed: " + e.message });
            }
        }

        // --- /clear ---
        if (text === "/clear") {
            const count = targetNumbers.size;
            targetNumbers.clear();
            await backupDatabase(client);
            await message.reply({ message: `[DONE] Database cleared. Removed ${count} numbers.` });
        }

        // --- /join ---
        if (text.startsWith("/join ")) {
            try {
                const link = text.split(" ")[1];
                let hash = link.replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                await message.reply({ message: "[SUCCESS] Joined group." });
            } catch (e) {
                await message.reply({ message: "[FAIL] " + (e.errorMessage || e.message) });
            }
        }

        // --- /save ---
        if (text === "/save" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                await message.reply({ message: "[PROCESSING] Reading file..." });
                try {
                    const buffer = await client.downloadMedia(replyMsg, {});
                    const content = buffer.toString('utf8');
                    const newNumbers = extractNumbersFromText(content);
                    
                    if (newNumbers.length > 0) {
                        newNumbers.forEach(n => targetNumbers.add(n));
                        await backupDatabase(client);
                        await message.reply({ message: `[SUCCESS] Added ${newNumbers.length} numbers.\nTotal: ${targetNumbers.size}` });
                    } else {
                        await message.reply({ message: "[ERROR] No numbers found." });
                    }
                } catch (e) {
                    await message.reply({ message: "[ERROR] Reading file failed." });
                }
            }
        }

        // --- /delete ---
        if (text === "/delete" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                const buffer = await client.downloadMedia(replyMsg, {});
                const delNums = extractNumbersFromText(buffer.toString('utf8'));
                
                const beforeSize = targetNumbers.size;
                delNums.forEach(n => targetNumbers.delete(n));
                
                await backupDatabase(client);
                await message.reply({ message: `[DONE] Removed: ${beforeSize - targetNumbers.size}` });
            }
        }

    }, new NewMessage({ incoming: true, outgoing: true })); 

})();
