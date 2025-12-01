require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System V13 Operational'));
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
let targetNumbers = new Set(); // Managed by Client A
let responseFilters = new Map(); // Managed by Client B
let pendingSearches = new Map(); 
let onlineInterval = null; 
let ghostMode = true; 

// ============================================================================
//  CORE 1: CLIENT A (THE HUNTER)
//  - Tasks: OTP Monitoring, Number Database, Search, Join
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING) return console.log("Skipping Client A");

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 10, useWSS: false });
    
    try {
        await clientA.start({ onError: (err) => console.log("Client A Error:", err) });
        console.log("✅ Hunter (A) Online");
    } catch (e) {
        console.log("❌ Client A Failed. Check Session.", e);
    }

    setInterval(() => { clientA.getMe().catch(() => {}); }, 30000);

    // --- DATABASE A (Numbers Only) ---
    async function backupNumbers() {
        try {
            const payload = { version: 1, numbers: [...targetNumbers] };
            const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
            buffer.name = "numbers_backup.json"; 
            await clientA.sendMessage("me", { message: "NUM_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup A Fail:", e); }
    }

    async function restoreNumbers() {
        try {
            const result = await clientA.getMessages("me", { search: "NUM_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                const rawData = JSON.parse(buffer.toString('utf8'));
                if (rawData.numbers) targetNumbers = new Set(rawData.numbers);
                console.log(`[A] Loaded ${targetNumbers.size} numbers.`);
            }
        } catch (e) { console.error("Restore A Fail:", e); }
    }
    await restoreNumbers();

    // --- PARSERS ---
    function extractNumbers(text) {
        return (text.match(/(?:\+|)\d{7,15}/g) || []).map(n => n.replace(/\+/g, ''));
    }

    function findOTP(text) {
        if (!text) return null;
        const match = text.match(/(?:^|\s|\n|:|-)((?:\d{3}[-\s]?\d{3}))(?:$|\s|\n)/);
        return match ? match[1].replace(/[-\s]/g, '').trim() : null;
    }

    // --- MONITORING ---
    clientA.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || "";
        
        if (targetNumbers.size > 0) {
            let fullText = text;
            if (message.replyMarkup?.rows) message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fullText+=" "+b.text }));

            for (const num of targetNumbers) {
                if (fullText.includes(num.slice(-4))) {
                    const otp = findOTP(fullText);
                    if (otp) {
                        if (adminId) await clientA.sendMessage(adminId, { message: `[ALERT] Match: ${num}\nOTP: \`${otp}\``, parseMode: "markdown" });
                        break;
                    }
                }
            }
        }
    }, new NewMessage({ incoming: true, outgoing: true }));

    // --- ACTIVE SEARCH ---
    clientA.addEventHandler(async (event) => {
        if (pendingSearches.size === 0) return;
        let fullText = event.message.text || "";
        if (event.message.replyMarkup?.rows) event.message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fullText+=" "+b.text }));

        for (const [suffix, info] of pendingSearches) {
            if (fullText.includes(suffix)) {
                const otp = findOTP(fullText);
                if (otp) {
                    clearTimeout(info.timer);
                    pendingSearches.delete(suffix);
                    await clientA.sendMessage(info.chatId, { message: `[FOUND LIVE]\nOTP: \`${otp}\``, parseMode: "markdown" });
                    return;
                }
            }
        }
    }, new NewMessage({ incoming: true }));

    // --- COMMANDS A ---
    clientA.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        if (!msg.out && !allowedUsers.includes(sender)) return;
        const txt = msg.text || "";

        try {
            if (txt === "/ping") await msg.reply({ message: "🥷 **Hunter (A):** ALIVE" });
            if (txt === "/start") await msg.reply({ message: "HUNTER V13 (OTP ONLY)" });

            if (txt === "/clear") { targetNumbers.clear(); await backupNumbers(); await msg.reply({ message: "Numbers Wiped." }); }
            
            if (txt.startsWith("/join ")) {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            }

            if (txt.startsWith("/s ")) {
                const rawQuery = txt.split(" ")[1];
                if (!rawQuery) return await msg.reply({ message: "Use: /s 5870" });
                const suffix = rawQuery.replace(/\D/g, '').slice(-4); 
                const chatId = msg.chatId;

                await msg.reply({ message: `🔍 Searching *${suffix}*...`, parseMode: 'markdown' });

                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: suffix, filter: new Api.InputMessagesFilterEmpty(),
                    minDate: Math.floor(Date.now()/1000) - 86400, 
                    limit: 50, offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0, maxDate: 0
                }));

                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        let fText = m.message || "";
                        if (m.replyMarkup?.rows) m.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fText+=" "+b.text }));
                        
                        if (fText.includes(suffix)) {
                            const otp = findOTP(fText);
                            if (otp) {
                                await msg.reply({ message: `[HISTORY MATCH]\nOTP: \`${otp}\``, parseMode: "markdown" });
                                found = true; break;
                            }
                        }
                    }
                }

                if (!found) {
                    await msg.reply({ message: `Listening live (2 mins)...` });
                    const timer = setTimeout(() => {
                        if (pendingSearches.has(suffix)) {
                            pendingSearches.delete(suffix);
                            clientA.sendMessage(chatId, { message: "Search Timeout." });
                        }
                    }, 120000);
                    pendingSearches.set(suffix, { chatId, timer });
                }
            }

            if ((txt === "/save" || txt === "/delete") && msg.isReply) {
                const reply = await msg.getReplyMessage();
                if (reply && reply.media) {
                    const buf = await clientA.downloadMedia(reply, {});
                    const nums = extractNumbers(buf.toString('utf8'));
                    if (txt === "/save") { nums.forEach(n => targetNumbers.add(n)); await msg.reply({ message: `Added ${nums.length}.` }); }
                    else { nums.forEach(n => targetNumbers.delete(n)); await msg.reply({ message: `Removed ${nums.length}.` }); }
                    await backupNumbers();
                }
            }

        } catch (e) { await msg.reply({ message: "Error: " + e.message }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();


// ============================================================================
//  CORE 2: CLIENT B (THE GHOST + AUTO-RESPONDER)
//  - Tasks: Ghost Mode, Online Status, /filter (Auto-Reply)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING_B) return console.log("Skipping Client B");

    const clientB = new TelegramClient(sessionB, apiId, apiHash, { connectionRetries: 10, useWSS: false });
    
    try {
        await clientB.start({ onError: (err) => console.log("Client B Error:", err) });
        console.log("✅ Ghost (B) Online");
    } catch (e) {
        console.log("❌ Client B Failed. Check Session B.", e);
    }

    setInterval(() => { clientB.getMe().catch(() => {}); }, 30000);

    // --- DATABASE B (Filters Only) ---
    async function backupFilters() {
        try {
            const payload = { version: 1, filters: Object.fromEntries(responseFilters) };
            const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
            buffer.name = "filters_backup.json"; 
            await clientB.sendMessage("me", { message: "FILTERS_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup B Fail:", e); }
    }

    async function restoreFilters() {
        try {
            const result = await clientB.getMessages("me", { search: "FILTERS_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientB.downloadMedia(result[0], {});
                const rawData = JSON.parse(buffer.toString('utf8'));
                if (rawData.filters) Object.entries(rawData.filters).forEach(([k, v]) => responseFilters.set(k, v));
                console.log(`[B] Loaded ${responseFilters.size} filters.`);
            }
        } catch (e) { console.error("Restore B Fail:", e); }
    }
    await restoreFilters();

    // --- STATUS ---
    async function keepOnline() { try { await clientB.invoke(new Api.account.UpdateStatus({ offline: false })); } catch (e) {} }

    // --- MONITORING (Ghost + Filters) ---
    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const text = msg.text || "";
        const sender = msg.senderId ? Number(msg.senderId) : null;

        // 1. AUTO-RESPONDER (Filters)
        if (responseFilters.size > 0) {
            for (const [trigger, response] of responseFilters) {
                // Check if message contains trigger (Case Insensitive)
                if (text.toLowerCase().includes(trigger.toLowerCase())) {
                    // Prevent responding to self to avoid infinite loops
                    if (msg.out) continue; 
                    
                    try { 
                        await msg.reply({ message: response }); 
                        console.log(`[B-FILTER] Triggered: ${trigger}`);
                        return; // Stop processing
                    } catch (e) {}
                }
            }
        }

        // 2. GHOST MODE (Auto-Read)
        if (!ghostMode && msg.incoming) { try { await clientB.markAsRead(msg.chatId); } catch (e) {} }
        
        // 3. COMMANDS (Auth Check)
        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/ping") await msg.reply({ message: "👻 **Ghost (B):** ALIVE" });
        if (txt === "/start") await msg.reply({ message: "GHOST V13 ONLINE\nUse /filter, /online, /ghost" });

        // --- FILTER COMMANDS (Now on Client B) ---
        if (text.startsWith("/filter ")) {
            if (!text.includes(',')) return await msg.reply({ message: "Error: Missing comma.\nUsage: /filter Trigger, Response" });
            const firstComma = text.indexOf(',');
            const trigger = text.substring(8, firstComma).trim();
            const response = text.substring(firstComma + 1).trim();
            
            responseFilters.set(trigger, response);
            await backupFilters();
            await msg.reply({ message: `✅ Filter Set on Client B:\n"${trigger}"` });
        }

        if (text.startsWith("/stop ")) {
            const trig = text.substring(6).trim();
            if (responseFilters.delete(trig)) {
                await backupFilters();
                await msg.reply({ message: "🗑 Filter Deleted." });
            } else {
                await msg.reply({ message: "❌ Filter not found." });
            }
        }

        if (text === "/filters") {
            let list = "**Active Filters (Client B):**\n";
            responseFilters.forEach((v, k) => list += `• \`${k}\`\n`);
            await msg.reply({ message: list });
        }

        // --- GHOST COMMANDS ---
        if (text === "/online on") { if (onlineInterval) clearInterval(onlineInterval); onlineInterval = setInterval(keepOnline, 60000); await keepOnline(); await msg.reply({ message: "🟢 ON" }); }
        if (text === "/online off") { if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; } await clientB.invoke(new Api.account.UpdateStatus({ offline: true })); await msg.reply({ message: "🔴 OFF" }); }
        if (text === "/ghost on") { ghostMode = true; await msg.reply({ message: "👻 Ghost ON" }); }
        if (text === "/ghost off") { ghostMode = false; await msg.reply({ message: "👀 Ghost OFF" }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
