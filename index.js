require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System V15 (Strict Filter + BroadNet Search)'));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- CONFIG ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const adminId = process.env.ADMIN_ID; 

const sessionA = new StringSession(process.env.SESSION_STRING); 
const sessionB = new StringSession(process.env.SESSION_STRING_B); 

const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// --- GLOBAL VARIABLES ---
let targetNumbers = new Set(); 
let responseFilters = new Map(); 
let pendingSearches = new Map(); 
let onlineInterval = null; 
let ghostMode = true; 

// ============================================================================
//  CORE 1: CLIENT A (HUNTER)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING) return console.log("Skipping Client A");

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 10, useWSS: false });
    await clientA.start({ onError: (err) => console.log(err) });
    console.log("✅ Hunter (A) Online");

    // Keep Alive
    setInterval(() => { clientA.getMe().catch(() => {}); }, 30000);

    // --- DATABASE ---
    async function backupDatabase() {
        try {
            const payload = { version: 4, numbers: [...targetNumbers], filters: Object.fromEntries(responseFilters) };
            const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
            buffer.name = "database_backup.json"; 
            await clientA.sendMessage("me", { message: "DB_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup A Fail:", e); }
    }

    async function restoreDatabase() {
        try {
            const result = await clientA.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                const rawData = JSON.parse(buffer.toString('utf8'));
                if (rawData.numbers) targetNumbers = new Set(rawData.numbers);
                if (rawData.filters) Object.entries(rawData.filters).forEach(([k, v]) => responseFilters.set(k, v));
                console.log(`[A] Loaded: ${targetNumbers.size} numbers, ${responseFilters.size} filters.`);
            }
        } catch (e) { console.error("Restore A Fail:", e); }
    }
    await restoreDatabase();

    // --- PARSERS ---
    function extractNumbers(text) {
        return (text.match(/(?:\+|)\d{7,15}/g) || []).map(n => n.replace(/\+/g, ''));
    }

    function normalizeMask(input) { 
        return input.replace(/[\u2055\u204E\u2217\u2022\u25CF]/g, '*'); 
    }

    function isMatch(real, masked) {
        let clean = normalizeMask(masked).replace(/[^0-9*]/g, '');
        if (real === clean) return true;
        if (clean.includes('*')) {
            const p = clean.split('*').filter(x => x.length > 0);
            if (p.length < 1) return false;
            return real.startsWith(p[0]) && real.endsWith(p[p.length - 1]);
        }
        return false;
    }

    function findOTP(text) {
        if (!text) return null;
        const match = text.match(/(?:^|\s|\n|:|-)((?:\d{3}[-\s]?\d{3}))(?:$|\s|\n)/);
        return match ? match[1].replace(/[-\s]/g, '').trim() : null;
    }

    function findMaskedNumber(text) {
        const match = text.match(/([0-9]{3,}[*\u2055\u204E\u2217\u2022\u25CF]+[0-9]{3,})/);
        return match ? match[0].trim() : null;
    }

    // --- MONITORING ---
    clientA.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";
        
        // 1. AUTO-RESPONDER (STRICT MODE)
        if (responseFilters.size > 0 && !message.out) {
            // Trim and Lowercase for exact match check
            const cleanText = text.trim().toLowerCase();
            
            for (const [trigger, response] of responseFilters) {
                if (cleanText === trigger.toLowerCase()) {
                    try { await message.reply({ message: response }); return; } catch (e) {}
                }
            }
        }

        // 2. PASSIVE MATCHING
        if (targetNumbers.size > 0) {
            let fullText = text;
            if (message.replyMarkup?.rows) message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fullText+=" "+b.text }));

            for (const num of targetNumbers) {
                // We check if the text contains a masked version of our number
                // This is hard to do efficiently, so we stick to checking suffixes/prefixes
                const suffix = num.slice(-4);
                if (fullText.includes(suffix)) { 
                    const otp = findOTP(fullText);
                    if (otp) {
                        if (adminId) await clientA.sendMessage(adminId, { message: `[ALERT] Match: ${num}\nOTP: \`${otp}\``, parseMode: "markdown" });
                        break;
                    }
                }
            }
        }
    }, new NewMessage({ incoming: true, outgoing: true }));

    // --- ACTIVE LISTENER ---
    clientA.addEventHandler(async (event) => {
        if (pendingSearches.size === 0) return;
        let fullText = event.message.text || "";
        if (event.message.replyMarkup?.rows) event.message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fullText+=" "+b.text }));

        for (const [suffix, info] of pendingSearches) {
            // Check if suffix matches
            if (fullText.includes(suffix)) {
                // Verify strict structure match
                const maskedNum = findMaskedNumber(fullText);
                if (maskedNum && isMatch(info.fullNumber, maskedNum)) {
                    const otp = findOTP(fullText);
                    if (otp) {
                        clearTimeout(info.timer);
                        pendingSearches.delete(suffix);
                        await clientA.sendMessage(info.chatId, { message: `[FOUND LIVE]\nSource: ${maskedNum}\nOTP: \`${otp}\``, parseMode: "markdown" });
                        return;
                    }
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

        try {
            if (txt === "/ping") await msg.reply({ message: "🥷 **Hunter (A):** ALIVE" });
            if (txt === "/start") await msg.reply({ message: "HUNTER V15 READY" });

            // FILTER
            if (txt.startsWith("/filter ")) {
                if (!txt.includes(',')) return await msg.reply({ message: "Error: Missing comma." });
                const firstComma = txt.indexOf(',');
                const trigger = txt.substring(8, firstComma).trim();
                const response = txt.substring(firstComma + 1).trim();
                responseFilters.set(trigger, response);
                await backupDatabase();
                await msg.reply({ message: `✅ Filter (Strict): "${trigger}"` });
            }

            if (txt.startsWith("/stop ")) {
                const trig = txt.substring(6).trim();
                if (responseFilters.delete(trig)) { await backupDatabase(); await msg.reply({ message: "Deleted." }); } 
                else { await msg.reply({ message: "Not found." }); }
            }

            if (txt === "/filters") {
                let list = "**Active Filters:**\n";
                responseFilters.forEach((v, k) => list += `• \`${k}\`\n`);
                await msg.reply({ message: list });
            }

            if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "DB Cleared." }); }
            
            if (txt.startsWith("/join ")) {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            }

            // --- BROADNET SEARCH (THE FIX) ---
            if (txt.startsWith("/s ")) {
                const rawQuery = txt.split(" ")[1];
                if (!rawQuery) return await msg.reply({ message: "Use: /s 5870" });
                const cleanQuery = rawQuery.replace(/\D/g, '');
                const suffix = cleanQuery.slice(-4); 
                const chatId = msg.chatId;

                await msg.reply({ message: `📡 BroadNet Scanning for *${suffix}*...`, parseMode: 'markdown' });

                // STRATEGY: Search "OTP" globally, then filter results locally.
                // This bypasses Telegram failing to index numbers/asterisks.
                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: "OTP", // Search for KEYWORD instead of number
                    filter: new Api.InputMessagesFilterEmpty(),
                    minDate: 0, 
                    limit: 100, // Fetch last 100 OTP messages
                    offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0, maxDate: 0
                }));

                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        let fText = m.message || "";
                        if (m.replyMarkup?.rows) m.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fText+=" "+b.text }));
                        
                        // Check if this OTP message belongs to our number
                        if (fText.includes(suffix)) {
                            // Extract Masked Number to be sure
                            const maskedNum = findMaskedNumber(fText);
                            if (maskedNum && isMatch(cleanQuery, maskedNum)) {
                                const otp = findOTP(fText);
                                if (otp) {
                                    await msg.reply({ message: `[HISTORY MATCH]\nSource: ${maskedNum}\nOTP: \`${otp}\``, parseMode: "markdown" });
                                    found = true; 
                                    break;
                                }
                            }
                        }
                    }
                }

                if (found) return;

                await msg.reply({ message: `Not in recent 100 OTPs. Listening live...` });
                const timer = setTimeout(() => {
                    if (pendingSearches.has(suffix)) {
                        pendingSearches.delete(suffix);
                        clientA.sendMessage(chatId, { message: "Search Timeout." });
                    }
                }, 60000);
                pendingSearches.set(suffix, { chatId, timer, fullNumber: cleanQuery });
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

        } catch (e) { await msg.reply({ message: "Error: " + e.message }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();


// ============================================================================
//  CORE 2: CLIENT B (GHOST + FILTERS)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING_B) return console.log("Skipping Client B");

    const clientB = new TelegramClient(sessionB, apiId, apiHash, { connectionRetries: 10, useWSS: false });
    await clientB.start({ onError: (err) => console.log("Client B Error:", err) });
    console.log("✅ Ghost (B) Online");

    setInterval(() => { clientB.getMe().catch(() => {}); }, 30000);

    async function keepOnline() { try { await clientB.invoke(new Api.account.UpdateStatus({ offline: false })); } catch (e) {} }

    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const txt = msg.text || "";
        const sender = msg.senderId ? Number(msg.senderId) : null;

        // 1. AUTO-RESPONDER (STRICT MODE for Client B too)
        if (responseFilters.size > 0 && !msg.out) { // Don't reply to self
            const cleanText = txt.trim().toLowerCase();
            for (const [trigger, response] of responseFilters) {
                if (cleanText === trigger.toLowerCase()) {
                    try { await msg.reply({ message: response }); return; } catch (e) {}
                }
            }
        }

        if (!ghostMode && msg.incoming) { try { await clientB.markAsRead(msg.chatId); } catch (e) {} }
        
        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/ping") await msg.reply({ message: "👻 **Ghost (B):** ALIVE" });
        if (txt === "/start") await msg.reply({ message: "GHOST V15 ONLINE" });

        // Filter Config (Redundant but keeps DB synced if you use B)
        if (txt.startsWith("/filter ")) {
            if (!txt.includes(',')) return await msg.reply({ message: "Error: Missing comma." });
            const firstComma = txt.indexOf(',');
            const trigger = txt.substring(8, firstComma).trim();
            const response = txt.substring(firstComma + 1).trim();
            responseFilters.set(trigger, response);
            // Note: B updates A's DB reference in memory if same process, but saving to file via A logic
            await msg.reply({ message: `✅ Filter (Strict): "${trigger}"` });
        }

        if (txt === "/online on") { if (onlineInterval) clearInterval(onlineInterval); onlineInterval = setInterval(keepOnline, 60000); await keepOnline(); await msg.reply({ message: "🟢 ON" }); }
        if (txt === "/online off") { if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; } await clientB.invoke(new Api.account.UpdateStatus({ offline: true })); await msg.reply({ message: "🔴 OFF" }); }
        if (txt === "/ghost on") { ghostMode = true; await msg.reply({ message: "👻 Ghost ON" }); }
        if (txt === "/ghost off") { ghostMode = false; await msg.reply({ message: "👀 Ghost OFF" }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
