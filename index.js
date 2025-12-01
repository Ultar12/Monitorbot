require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System V10 Active'));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const adminId = process.env.ADMIN_ID; 

const sessionA = new StringSession(process.env.SESSION_STRING); 
const sessionB = new StringSession(process.env.SESSION_STRING_B); 

const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

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

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 5 });
    await clientA.start({ onError: (err) => console.log(err) });
    console.log("✅ Hunter Online");

    // --- DATABASE ---
    async function backupDatabase() {
        try {
            const payload = {
                version: 3,
                numbers: [...targetNumbers],
                filters: Object.fromEntries(responseFilters)
            };
            const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
            buffer.name = "database_backup.json"; 
            await clientA.sendMessage("me", { message: "DB_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup Fail:", e); }
    }

    async function restoreDatabase() {
        try {
            const result = await clientA.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                const rawData = JSON.parse(buffer.toString('utf8'));
                if (rawData.numbers) targetNumbers = new Set(rawData.numbers);
                if (rawData.filters) Object.entries(rawData.filters).forEach(([k, v]) => responseFilters.set(k, v));
                console.log(`Loaded ${targetNumbers.size} nums, ${responseFilters.size} filters.`);
            }
        } catch (e) { console.error("Restore Fail:", e); }
    }
    await restoreDatabase();

    // --- PARSERS ---
    function extractNumbers(text) {
        const matches = text.match(/(?:\+|)\d{7,15}/g);
        return matches ? matches.map(n => n.replace(/\+/g, '')) : [];
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
        
        // 1. AUTO-RESPONDER (Check trigger first)
        if (responseFilters.size > 0) {
            for (const [trigger, response] of responseFilters) {
                if (text.toLowerCase().includes(trigger.toLowerCase())) {
                    if (text === response) continue; // Loop protection
                    try { await message.reply({ message: response }); return; } catch (e) {}
                }
            }
        }

        // 2. PASSIVE MATCHING
        if (targetNumbers.size > 0) {
            let fullText = text;
            if (message.replyMarkup?.rows) {
                message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if (b.text) fullText += " " + b.text; }));
            }

            for (const num of targetNumbers) {
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

    // --- GLOBAL LISTENER (Active Search) ---
    clientA.addEventHandler(async (event) => {
        if (pendingSearches.size === 0) return;
        
        let fullText = event.message.text || "";
        if (event.message.replyMarkup?.rows) {
            event.message.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if (b.text) fullText += " " + b.text; }));
        }

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

    // --- COMMANDS ---
    clientA.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        
        // Authorization Check
        if (!msg.out && !allowedUsers.includes(sender)) return;

        const txt = msg.text || "";

        try {
            if (txt === "/start") await msg.reply({ message: "HUNTER V10 READY" });

            // FILTER
            if (txt.startsWith("/filter ")) {
                if (!txt.includes(',')) return await msg.reply({ message: "Error: Missing comma.\nUse: /filter Word, Reply" });
                const args = txt.substring(8).split(',');
                const trig = args[0].trim();
                const resp = args.slice(1).join(',').trim();
                responseFilters.set(trig, resp);
                await backupDatabase();
                await msg.reply({ message: `Saved Filter: "${trig}"` });
            }

            if (txt.startsWith("/stop ")) {
                const trig = txt.substring(6).trim();
                if (responseFilters.delete(trig)) {
                    await backupDatabase();
                    await msg.reply({ message: "Filter Deleted." });
                } else {
                    await msg.reply({ message: "Filter not found." });
                }
            }

            if (txt === "/filters") {
                let list = "Filters:\n";
                responseFilters.forEach((v, k) => list += `• ${k} -> ${v}\n`);
                await msg.reply({ message: list });
            }

            // DB
            if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "DB Cleared." }); }

            if (txt.startsWith("/join ")) {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            }

            // SEARCH
            if (txt.startsWith("/s ")) {
                const rawQuery = txt.split(" ")[1];
                if (!rawQuery) return await msg.reply({ message: "Use: /s 5870" });
                const suffix = rawQuery.replace(/\D/g, '').slice(-4);
                const chatId = msg.chatId;

                await msg.reply({ message: `Searching *${suffix}*...`, parseMode: 'markdown' });

                // 1. History
                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: suffix, filter: new Api.InputMessagesFilterEmpty(),
                    minDate: Math.floor(Date.now()/1000) - 900, limit: 50,
                    offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0, maxDate: 0
                }));

                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        let fText = m.message || "";
                        if (m.replyMarkup?.rows) m.replyMarkup.rows.forEach(r => r.buttons?.forEach(b => { if(b.text) fText+=" "+b.text }));
                        
                        if (fText.includes(suffix)) {
                            const otp = findOTP(fText);
                            if (otp) {
                                await msg.reply({ message: `[HISTORY] OTP: \`${otp}\``, parseMode: "markdown" });
                                found = true; break;
                            }
                        }
                    }
                }

                if (!found) {
                    await msg.reply({ message: "Listening live (1 min)..." });
                    const timer = setTimeout(() => {
                        if (pendingSearches.has(suffix)) {
                            pendingSearches.delete(suffix);
                            clientA.sendMessage(chatId, { message: "Search Timeout." });
                        }
                    }, 60000);
                    pendingSearches.set(suffix, { chatId, timer });
                }
            }

            // SAVE/DELETE
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

        } catch (e) {
            console.error("Command Error:", e);
            await msg.reply({ message: "Error: " + e.message });
        }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();


// ============================================================================
//  CORE 2: CLIENT B (GHOST)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING_B) return console.log("Skipping Client B");

    const clientB = new TelegramClient(sessionB, apiId, apiHash, { connectionRetries: 5 });
    await clientB.start({ onError: (err) => console.log("Client B Error:", err) });
    console.log("✅ Ghost Online");

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
