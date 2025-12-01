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

let targetNumbers = new Set(); 
let pendingSearches = new Map(); 

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

// --- 4. PARSING LOGIC (AGGRESSIVE) ---

function extractNumbersFromText(textContent) {
    const regex = /(?:\+|)\d{7,15}/g;
    const matches = textContent.match(regex);
    if (!matches) return [];
    return matches.map(num => num.replace(/\+/g, ''));
}

// Helper to handle ALL weird unicode asterisks
function normalizeMask(input) {
    // Replaces: 
    // ⁕ (U+2055), ⁎ (U+204E), ∗ (U+2217), • (U+2022), ● (U+25CF)
    // with standard *
    return input.replace(/[\u2055\u204E\u2217\u2022\u25CF]/g, '*');
}

function isMaskedMatch(realNumber, maskedNumber) {
    // 1. Normalize weird symbols to normal '*'
    let cleanMasked = normalizeMask(maskedNumber);
    
    // 2. Remove anything that isn't a digit or *
    cleanMasked = cleanMasked.replace(/[^0-9*]/g, ''); 
    
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

function parseMessageFull(message) {
    if (!message) return null;

    let combinedText = message.message || ""; 

    // Combine Text + Button Text
    if (message.replyMarkup && message.replyMarkup.rows) {
        message.replyMarkup.rows.forEach(row => {
            if (row.buttons) {
                row.buttons.forEach(btn => {
                    if (btn.text) combinedText += " " + btn.text;
                });
            }
        });
    }

    if (combinedText.length < 5) return null;

    // --- AGGRESSIVE REGEX UPGRADE ---
    
    // 1. Find OTP: Matches 3-3 digits (123-456) OR 6 digits (123456)
    // We now allow surrounding spaces or newlines to ensure we catch it
    const otpRegex = /(?:^|\s|\n|:|-)([\d]{3}[-\s]?[\d]{3})(?:$|\s|\n)/;
    
    // 2. Find Number: 
    // Matches digits + (any * or weird dot) + digits
    // Example: 23470⁕⁕⁕⁕5870 or 234***567
    const numRegex = /([0-9]{3,}[\*⁕⁎∗•●]+[0-9]{3,})/;

    const otpMatch = combinedText.match(otpRegex);
    const numMatch = combinedText.match(numRegex);

    if (otpMatch && numMatch) {
        // Return the capture group (the actual numbers/OTP)
        return {
            otp: otpMatch[1].replace(/[-\s]/g, '').trim(), // Clean the OTP (123-456 -> 123456)
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
        const data = parseMessageFull(message);
        
        if (data) {
            // Active Search
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

            // Database Check
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

        if (text === "/start") {
            await message.reply({ 
                message: "SYSTEM ONLINE\n\nCOMMANDS:\n/save - Add from file\n/delete - Remove from file\n/clear - Wipe DB\n/s <number> - Deep Search\n/join <link> - Join group"
            });
        }

        // --- /s (DEEP SEARCH) ---
        if (text.startsWith("/s ")) {
            const queryNum = text.split(" ")[1];
            if (!queryNum) return await message.reply({ message: "[ERROR] Format: /s 23480..." });

            const cleanQueryNum = queryNum.replace(/\D/g, '');
            const chatId = message.chatId;

            await message.reply({ message: `[SEARCHING] Deep scanning for ${cleanQueryNum}...` });

            try {
                const thirtyMinsAgo = Math.floor(Date.now() / 1000) - 1800;
                // Search LAST 4 digits (e.g. 5870) to find the message
                const suffix = cleanQueryNum.slice(-4);
                
                const result = await client.invoke(new Api.messages.SearchGlobal({
                    q: suffix,
                    filter: new Api.InputMessagesFilterEmpty(),
                    minDate: thirtyMinsAgo, 
                    maxDate: 0,
                    offsetRate: 0,
                    offsetPeer: new Api.InputPeerEmpty(),
                    offsetId: 0,
                    limit: 50,
                    folderId: 0
                }));

                let found = false;
                if (result.messages) {
                    for (const msg of result.messages) {
                        const data = parseMessageFull(msg);
                        
                        // Debug log (Check Render logs if it fails)
                        if (data) console.log(`[DEBUG] Found: ${data.number} | OTP: ${data.otp}`);

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

                await message.reply({ message: `[WAITING] Not in history. Listening live for 2 minutes...` });

                const timer = setTimeout(async () => {
                    if (pendingSearches.has(cleanQueryNum)) {
                        pendingSearches.delete(cleanQueryNum);
                        await client.sendMessage(chatId, { message: `[TIMEOUT] Search ended for ${cleanQueryNum}.` });
                    }
                }, 120000); 

                pendingSearches.set(cleanQueryNum, { chatId, timer });

            } catch (e) {
                console.error(e);
                await message.reply({ message: "[ERROR] Search failed: " + e.message });
            }
        }

        // Standard commands
        if (text === "/clear") {
            targetNumbers.clear();
            await backupDatabase(client);
            await message.reply({ message: `[DONE] Database wiped.` });
        }

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
