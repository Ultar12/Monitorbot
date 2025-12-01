require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System Operational'));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- 2. CONFIG ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const sessionString = process.env.SESSION_STRING; 
const adminId = process.env.ADMIN_ID; 

const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// STORAGE
let targetNumbers = new Set(); 
let pendingSearches = new Map(); // Key=RealNumber, Value={chatId, timer}

// --- 3. DATABASE ---
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
        }
    } catch (e) {
        console.error("Restore Error:", e);
    }
}

// --- 4. PARSING ---
function extractNumbersFromText(textContent) {
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    return matches.map(num => num.replace(/\+/g, ''));
}

function isMaskedMatch(realNumber, maskedNumber) {
    const cleanMasked = maskedNumber.replace(/[^0-9*]/g, ''); 
    if (realNumber === cleanMasked) return true;
    if (cleanMasked.includes('*')) {
        const parts = cleanMasked.split('*').filter(p => p.length > 0);
        if (parts.length < 1) return false;
        const prefix = parts[0];
        const suffix = parts[parts.length - 1];
        return realNumber.startsWith(prefix) && realNumber.endsWith(suffix);
    }
    return false;
}

function parseMessageForOtp(text) {
    if (!text || text.length < 5) return null;
    const otpRegex = /(?:\b\d{3}[-\s]\d{3}\b|\b\d{6}\b)/;
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
        console.error("FATAL: SESSION_STRING missing.");
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({ onError: (err) => console.log(err) });
    console.log("[START] System Online");
    
    await restoreDatabase(client);

    // --- MONITORING ---
    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";
        
        const data = parseMessageForOtp(text);
        
        if (data) {
            // 1. ACTIVE SEARCH CHECK
            for (const [realNum, searchInfo] of pendingSearches) {
                if (isMaskedMatch(realNum, data.number)) {
                    clearTimeout(searchInfo.timer);
                    pendingSearches.delete(realNum);
                    await client.sendMessage(searchInfo.chatId, { 
                        message: `[FOUND] Live Match\nSource: ${data.number}\nOTP Below:`
                    });
                    await client.sendMessage(searchInfo.chatId, { 
                        message: `\`${data.otp}\``,
                        parseMode: "markdown"
                    });
                    return; 
                }
            }

            // 2. PASSIVE DATABASE CHECK
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
                        message: `[ALERT] Database Match\nReal: ${foundRealNumber}\nMasked: ${data.number}\nOTP Below:`
                    });
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

        // /start
        if (text === "/start") {
            await message.reply({ 
                message: "SYSTEM ONLINE\n\nCOMMANDS:\n/save - Add from file\n/delete - Remove from file\n/clear - Wipe DB\n/s <number> - Search (History + Live)\n/join <link> - Join group"
            });
        }

        // /s (DEEP SEARCH - FIXED)
        if (text.startsWith("/s ")) {
            const queryNum = text.split(" ")[1];
            if (!queryNum) return await message.reply({ message: "[ERROR] Format: /s 23480..." });

            const cleanQueryNum = queryNum.replace(/\D/g, '');
            const chatId = message.chatId;

            await message.reply({ message: `[SEARCHING] Checking history...` });

            try {
                // FIXED: Now we provide EVERY SINGLE PARAMETER required by GramJS
                const thirtyMinsAgo = Math.floor(Date.now() / 1000) - 1800;
                
                // We search for just the last 4 digits to find potential matches
                const suffix = cleanQueryNum.slice(-4);

                const result = await client.invoke(new Api.messages.SearchGlobal({
                    q: suffix,
                    filter: new Api.InputMessagesFilterEmpty(),
                    minDate: thirtyMinsAgo,
                    maxDate: 0,              // Was missing
                    offsetRate: 0,           // Was missing
                    offsetPeer: new Api.InputPeerEmpty(), // Was missing
                    offsetId: 0,             // Was missing
                    limit: 50,
                    folderId: 0              // Optional but good to be explicit
                }));

                let found = false;
                if (result.messages) {
                    for (const msg of result.messages) {
                        const data = parseMessageForOtp(msg.message || "");
                        if (data && isMaskedMatch(cleanQueryNum, data.number)) {
                            await message.reply({ 
                                message: `[FOUND HISTORY]\nSource: ${data.number}\nOTP: \`${data.otp}\``,
                                parseMode: "markdown"
                            });
                            found = true;
                            break; 
                        }
                    }
                }

                if (found) return; 

                // If not found, start listening
                await message.reply({ message: `[WAITING] Not in history. Listening live for 2 minutes...` });

                const timer = setTimeout(async () => {
                    if (pendingSearches.has(cleanQueryNum)) {
                        pendingSearches.delete(cleanQueryNum);
                        await client.sendMessage(chatId, { message: `[TIMEOUT] No OTP found for ${cleanQueryNum}.` });
                    }
                }, 120000); 

                pendingSearches.set(cleanQueryNum, { chatId, timer });

            } catch (e) {
                console.error(e);
                await message.reply({ message: "[ERROR] Search failed: " + e.message });
            }
        }

        // /clear
        if (text === "/clear") {
            targetNumbers.clear();
            await backupDatabase(client);
            await message.reply({ message: `[DONE] Database wiped.` });
        }

        // /join
        if (text.startsWith("/join ")) {
            try {
                const link = text.split(" ")[1];
                let hash = link.replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await client.invoke(new Api.messages.ImportChatInvite({ hash: hash }));
                await message.reply({ message: "[SUCCESS] Joined." });
            } catch (e) {
                await message.reply({ message: "[FAIL] " + e.message });
            }
        }

        // /save
        if (text === "/save" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                await message.reply({ message: "[PROCESSING]..." });
                try {
                    const buffer = await client.downloadMedia(replyMsg, {});
                    const newNumbers = extractNumbersFromText(buffer.toString('utf8'));
                    newNumbers.forEach(n => targetNumbers.add(n));
                    await backupDatabase(client);
                    await message.reply({ message: `[SUCCESS] Added: ${newNumbers.length}\nTotal: ${targetNumbers.size}` });
                } catch (e) {
                    await message.reply({ message: "[ERROR] File read failed." });
                }
            }
        }

        // /delete
        if (text === "/delete" && message.isReply) {
            const replyMsg = await message.getReplyMessage();
            if (replyMsg && replyMsg.media) {
                const buffer = await client.downloadMedia(replyMsg, {});
                const delNums = extractNumbersFromText(buffer.toString('utf8'));
                delNums.forEach(n => targetNumbers.delete(n));
                await backupDatabase(client);
                await message.reply({ message: `[DONE] Removed numbers.` });
            }
        }

    }, new NewMessage({ incoming: true, outgoing: true })); 

})();
