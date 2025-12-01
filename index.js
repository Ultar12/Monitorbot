require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System Operational (V8)'));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- CONFIG ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const adminId = process.env.ADMIN_ID; 

const sessionA = new StringSession(process.env.SESSION_STRING); 
const sessionB = new StringSession(process.env.SESSION_STRING_B); 

const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// --- GLOBAL VARIABLES ---
let targetNumbers = new Set(); 
let responseFilters = new Map(); 
let pendingSearches = new Map(); 
let onlineInterval = null; 
let ghostMode = true; 

// ============================================================================
//  CORE 1: CLIENT A (THE HUNTER + AUTO-RESPONDER)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING) return console.log("Skipping Client A");

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 5 });
    await clientA.start({ onError: (err) => console.log(err) });
    console.log("✅ Hunter (A) Online");

    // --- DATABASE MANAGER ---
    async function backupDatabase() {
        try {
            const payload = {
                version: 2,
                numbers: [...targetNumbers],
                filters: Object.fromEntries(responseFilters)
            };
            const data = JSON.stringify(payload, null, 2);
            const buffer = Buffer.from(data, 'utf8');
            buffer.name = "database_backup.json"; 
            await clientA.sendMessage("me", { message: "DB_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup Error:", e); }
    }

    async function restoreDatabase() {
        try {
            const result = await clientA.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                const rawData = JSON.parse(buffer.toString('utf8'));
                if (Array.isArray(rawData)) {
                    targetNumbers = new Set(rawData);
                } else {
                    if (rawData.numbers) targetNumbers = new Set(rawData.numbers);
                    if (rawData.filters) responseFilters = new Map(Object.entries(rawData.filters));
                }
                console.log(`[RESTORE] Loaded ${targetNumbers.size} numbers.`);
            }
        } catch (e) { console.error("Restore Error:", e); }
    }
    await restoreDatabase();

    // --- HELPER FUNCTIONS ---
    function extractNumbers(text) {
        const regex = /(?:\+|)\d{7,15}/g;
        const matches = text.match(regex);
        return matches ? matches.map(n => n.replace(/\+/g, '')) : [];
    }

    function normalizeMask(input) { 
        // Replaces ALL types of fancy bullets/asterisks
        return input.replace(/[\u2055\u204E\u2217\u2022\u25CF]/g, '*'); 
    }

    function isMatch(queryNum, msgMaskedNum) {
        const cleanMasked = normalizeMask(msgMaskedNum).replace(/[^0-9*]/g, '');
        const cleanQuery = queryNum.replace(/[^0-9]/g, '');

        // Suffix Match (Last 4)
        if (cleanQuery.length < 7) return cleanMasked.endsWith(cleanQuery);

        // Full Match (Masked)
        if (cleanMasked.includes('*')) {
            const parts = cleanMasked.split('*').filter(x => x.length > 0);
            if (parts.length < 1) return false;
            const prefix = parts[0];
            const suffix = parts[parts.length - 1];
            return cleanQuery.startsWith(prefix) && cleanQuery.endsWith(suffix);
        }
        return cleanQuery === cleanMasked;
    }

    // --- THE CRITICAL PARSER ---
    function parseMsg(message) {
        if (!message) return null;
        let txt = message.message || "";
        
        // Combine Button Text
        if (message.replyMarkup && message.replyMarkup.rows) {
            message.replyMarkup.rows.forEach(r => r.buttons && r.buttons.forEach(b => { if (b.text) txt += " " + b.text; }));
        }
        if (txt.length < 5) return null;

        // 1. OTP Regex: 3-3 digits OR 6 digits OR 3 space 3
        const otpRegex = /(?:^|\s|\n|:|-)((?:\d{3}[-\s]?\d{3}))(?:$|\s|\n)/;
        
        // 2. Number Regex: digits + any weird chars + digits
        // Allow for spaces/symbols between digits and mask
        const numRegex = /([0-9]{3,}[\s]*[*\u2055\u204E\u2217\u2022\u25CF]+[\s]*[0-9]{3,})/;

        const o = txt.match(otpRegex);
        const n = txt.match(numRegex);

        if (o && n) {
            return { 
                otp: o[1].replace(/[-\s]/g, '').trim(), 
                number: n[0].replace(/\s/g, '').trim() // Remove spaces from number
            };
        }
        return null;
    }

    // --- MONITORING ---
    clientA.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";
        
        // Filter Logic
        if (responseFilters.size > 0 && !message.out) {
            for (const [trigger, response] of responseFilters) {
                if (text.toLowerCase().includes(trigger.toLowerCase())) {
                    try { await message.reply({ message: response }); return; } catch (e) {}
                }
            }
        }

        // OTP Logic
        const data = parseMsg(message);
        if (data) {
            const suffix = data.number.replace(/[^0-9]/g, '').slice(-4); 

            if (pendingSearches.has(suffix)) {
                const searchInfo = pendingSearches.get(suffix);
                if (isMatch(searchInfo.fullNumber, data.number)) {
                    clearTimeout(searchInfo.timer);
                    pendingSearches.delete(suffix);
                    await clientA.sendMessage(searchInfo.chatId, { message: `[FOUND] Live Match\nSource: ${data.number}\nOTP Below:` });
                    await clientA.sendMessage(searchInfo.chatId, { message: `\`${data.otp}\``, parseMode: "markdown" });
                    return;
                }
            }

            for (const num of targetNumbers) {
                if (isMatch(num, data.number)) {
                    if (adminId) await clientA.sendMessage(adminId, { message: `[ALERT] Match: ${num}\nOTP: \`${data.otp}\``, parseMode: "markdown" });
                    break;
                }
            }
        }
    }, new NewMessage({ incoming: true }));

    // --- COMMANDS ---
    clientA.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        if (!msg.out && !allowedUsers.includes(sender)) return;
        const txt = msg.text || "";

        if (txt === "/start") await msg.reply({ message: "HUNTER V8 ONLINE" });

        // Filter Config
        if (txt.startsWith("/filter ")) {
            const args = txt.substring(8).split(',');
            if (args.length < 2) return await msg.reply({ message: "Usage: /filter Trigger, Response" });
            responseFilters.set(args[0].trim(), args.slice(1).join(',').trim());
            await backupDatabase();
            await msg.reply({ message: "Filter Added." });
        }
        if (txt.startsWith("/stop ")) {
            const trigger = txt.substring(6).trim();
            if (responseFilters.delete(trigger)) { await backupDatabase(); await msg.reply({ message: "Deleted." }); }
        }
        if (txt === "/filters") {
            let list = "Filters:\n"; responseFilters.forEach((v, k) => list += `${k} -> ${v}\n`);
            await msg.reply({ message: list || "None." });
        }

        // Existing Config
        if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "DB wiped." }); }
        
        if (txt.startsWith("/join ")) {
            try {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            } catch (e) { await msg.reply({ message: "Error: " + e.message }); }
        }

        // --- DEEP SEARCH ---
        if (txt.startsWith("/s ")) {
            const rawQuery = txt.split(" ")[1];
            if (!rawQuery) return await msg.reply({ message: "Usage: /s 5870" });

            const cleanQuery = rawQuery.replace(/\D/g, '');
            const suffix = cleanQuery.slice(-4); 
            const chatId = msg.chatId;

            await msg.reply({ message: `Searching *${suffix}* (Check logs if fails)...`, parseMode: 'markdown' });

            try {
                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: suffix, filter: new Api.InputMessagesFilterEmpty(),
                    minDate: Math.floor(Date.now()/1000) - 900, // 15 mins ago
                    limit: 50, offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0, maxDate: 0
                }));

                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        // LOGGING FOR DEBUGGING
                        const d = parseMsg(m);
                        if (d) console.log(`[DEBUG] Found: ${d.number} | OTP: ${d.otp}`);
                        
                        if (d && isMatch(cleanQuery, d.number)) {
                            await msg.reply({ message: `[HISTORY] Source: ${d.number}\nOTP: \`${d.otp}\``, parseMode: "markdown" });
                            found = true; break;
                        }
                    }
                }

                if (found) return;

                await msg.reply({ message: `Not in history. Listening...` });
                const timer = setTimeout(() => {
                    if (pendingSearches.has(suffix)) { 
                        pendingSearches.delete(suffix); 
                        clientA.sendMessage(chatId, { message: `Search Timeout.` }); 
                    }
                }, 60000);
                pendingSearches.set(suffix, { chatId, timer, fullNumber: cleanQuery });

            } catch (e) { await msg.reply({ message: "Error: " + e.message }); }
        }

        if ((txt === "/save" || txt === "/delete") && msg.isReply) {
            const reply = await msg.getReplyMessage();
            if (reply && reply.media) {
                const buf = await clientA.downloadMedia(reply, {});
                const nums = extractNumbers(buf.toString('utf8'));
                if (txt === "/save") { nums.forEach(n => targetNumbers.add(n)); await msg.reply({ message: `Added ${nums.length}.` }); }
                else { nums.forEach(n => targetNumbers.delete(n)); await msg.reply({ message: `Removed ${nums.length}.` }); }
                await backupDatabase();
            }
        }
    }, new NewMessage({ incoming: true, outgoing: true }));
})();


// ============================================================================
//  CORE 2: CLIENT B (THE GHOST)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING_B) return console.log("Skipping Client B");

    const clientB = new TelegramClient(sessionB, apiId, apiHash, { connectionRetries: 5 });
    await clientB.start({ onError: (err) => console.log("Client B Error:", err) });
    console.log("✅ Ghost (B) Online");

    async function keepOnline() { try { await clientB.invoke(new Api.account.UpdateStatus({ offline: false })); } catch (e) {} }

    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        const txt = msg.text || "";

        if (!ghostMode && msg.incoming) { try { await clientB.markAsRead(msg.chatId); } catch (e) {} }
        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/start") await msg.reply({ message: "GHOST ONLINE" });
        if (txt === "/online on") { if (onlineInterval) clearInterval(onlineInterval); onlineInterval = setInterval(keepOnline, 60000); await keepOnline(); await msg.reply({ message: "ON" }); }
        if (txt === "/online off") { if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; } await clientB.invoke(new Api.account.UpdateStatus({ offline: true })); await msg.reply({ message: "OFF" }); }
        if (txt === "/ghost on") { ghostMode = true; await msg.reply({ message: "Ghost ON" }); }
        if (txt === "/ghost off") { ghostMode = false; await msg.reply({ message: "Ghost OFF" }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
