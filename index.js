require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Dual Core System Active'));
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

// --- GLOBAL VARS ---
let targetNumbers = new Set(); 
let pendingSearches = new Map(); 
let onlineInterval = null; 
let ghostMode = true; 

// ============================================================================
//  CORE 1: CLIENT A (THE HUNTER)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING) return console.log("Skipping Client A");

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 5 });
    await clientA.start({ onError: (err) => console.log(err) });
    console.log("✅ Hunter (A) Online");

    // --- DATABASE ---
    async function backupDatabase() {
        try {
            const data = JSON.stringify([...targetNumbers], null, 2);
            const buffer = Buffer.from(data, 'utf8');
            buffer.name = "database_backup.json"; 
            await clientA.sendMessage("me", { message: "DB_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error(e); }
    }

    async function restoreDatabase() {
        try {
            const result = await clientA.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                targetNumbers = new Set(JSON.parse(buffer.toString('utf8')));
                console.log(`Restored ${targetNumbers.size} numbers.`);
            }
        } catch (e) { console.error(e); }
    }
    
    await restoreDatabase();

    // --- PARSING ---
    function extractNumbers(text) {
        const regex = /(?:\+|)\d{7,15}/g;
        const matches = text.match(regex);
        return matches ? matches.map(n => n.replace(/\+/g, '')) : [];
    }

    function normalizeMask(input) { return input.replace(/[\u2055\u204E\u2217\u2022\u25CF]/g, '*'); }

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

    function parseMsg(message) {
        if (!message) return null;
        let txt = message.message || "";
        if (message.replyMarkup && message.replyMarkup.rows) {
            message.replyMarkup.rows.forEach(r => r.buttons && r.buttons.forEach(b => { if (b.text) txt += " " + b.text; }));
        }
        if (txt.length < 5) return null;
        const otpRegex = /(?:^|\s|\n|:|-)([\d]{3}[-\s]?[\d]{3})(?:$|\s|\n)/;
        const numRegex = /([0-9]{3,}[\*⁕⁎∗•●]+[0-9]{3,})/;
        const o = txt.match(otpRegex);
        const n = txt.match(numRegex);
        if (o && n) return { otp: o[1].replace(/[-\s]/g, '').trim(), number: n[0].trim() };
        return null;
    }

    // --- MONITORING (Passive) ---
    // Note: This reads messages from the socket WITHOUT marking them as read.
    // Double ticks will NOT appear unless you open the chat on your phone.
    clientA.addEventHandler(async (event) => {
        const data = parseMsg(event.message);
        if (data) {
            for (const [real, info] of pendingSearches) {
                if (isMatch(real, data.number)) {
                    clearTimeout(info.timer);
                    pendingSearches.delete(real);
                    await clientA.sendMessage(info.chatId, { message: `[FOUND] Live Match\nOTP: \`${data.otp}\``, parseMode: "markdown" });
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

        if (txt === "/start") await msg.reply({ message: "HUNTER ONLINE\n/s <num>, /save, /delete, /clear, /join <link>" });
        if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "DB wiped." }); }
        
        if (txt.startsWith("/join ")) {
            try {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            } catch (e) { await msg.reply({ message: "Error: " + e.message }); }
        }

        if (txt.startsWith("/s ")) {
            const q = txt.split(" ")[1].replace(/\D/g, '');
            const chatId = msg.chatId;
            await msg.reply({ message: `Searching ${q}...` });
            try {
                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: q.slice(-4), filter: new Api.InputMessagesFilterEmpty(),
                    minDate: Math.floor(Date.now()/1000)-1800, limit: 50, maxDate: 0, offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0
                }));
                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        const d = parseMsg(m);
                        if (d && isMatch(q, d.number)) {
                            await msg.reply({ message: `[HISTORY] OTP: \`${d.otp}\``, parseMode: "markdown" });
                            found = true; break;
                        }
                    }
                }
                if (!found) {
                    await msg.reply({ message: "Listening live for 2 mins..." });
                    const timer = setTimeout(() => {
                        if (pendingSearches.has(q)) { pendingSearches.delete(q); clientA.sendMessage(chatId, { message: `Timeout: ${q}` }); }
                    }, 120000);
                    pendingSearches.set(q, { chatId, timer });
                }
            } catch (e) { await msg.reply({ message: "Error: " + e.message }); }
        }

        if ((txt === "/save" || txt === "/delete") && msg.isReply) {
            const reply = await msg.getReplyMessage();
            if (reply && reply.media) {
                const buf = await clientA.downloadMedia(reply, {});
                const nums = extractNumbers(buf.toString('utf8'));
                if (txt === "/save") { nums.forEach(n => targetNumbers.add(n)); await msg.reply({ message: `Added ${nums.length}. Total: ${targetNumbers.size}` }); }
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

    // --- STATUS MANAGER ---
    async function keepOnline() {
        try {
            // Force 'True' online status (active presence)
            await clientB.invoke(new Api.account.UpdateStatus({ offline: false }));
        } catch (e) { console.error("Online Error:", e); }
    }

    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        const txt = msg.text || "";

        // GHOST MODE: 
        // If this handler does NOT verify 'markAsRead', the sender sees 1 tick.
        // If you open the chat on your phone, your PHONE sends 'read', causing 2 ticks.
        // To verify this works: Check 'Saved Messages' for forwarded logs (if you add forwarding).
        
        if (!ghostMode && msg.incoming) {
            try { await clientB.markAsRead(msg.chatId); } catch (e) {}
        }

        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/start") await msg.reply({ message: "GHOST ONLINE\n/online on/off\n/ghost on/off" });

        if (txt === "/online on") {
            if (onlineInterval) clearInterval(onlineInterval);
            // Ping every 60 seconds to be aggressive
            onlineInterval = setInterval(keepOnline, 60000); 
            await keepOnline();
            await msg.reply({ message: "🟢 Always Online: ACTIVE" });
        }

        if (txt === "/online off") {
            if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; }
            await clientB.invoke(new Api.account.UpdateStatus({ offline: true }));
            await msg.reply({ message: "🔴 Always Online: OFF" });
        }

        if (txt === "/ghost on") {
            ghostMode = true;
            await msg.reply({ message: "👻 Ghost Mode: ON (I won't mark as read)" });
        }

        if (txt === "/ghost off") {
            ghostMode = false;
            await msg.reply({ message: "👀 Ghost Mode: OFF (Auto-Reading)" });
        }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
