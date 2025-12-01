require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER (Keeps Both Bots Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('System Operational: Dual Core Active'));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- CONFIGURATION ---
const apiId = 34884606; 
const apiHash = "4148aa2a18ccfd60018b1ab06cd09d96";
const adminId = process.env.ADMIN_ID; 

// CLIENT A (The Hunter - OTP Monitor)
const sessionA = new StringSession(process.env.SESSION_STRING); 
// CLIENT B (The Ghost - Status Manager)
const sessionB = new StringSession(process.env.SESSION_STRING_B); 

// Allowed Users (Applies to both)
const allowedUsersRaw = process.env.ALLOWED_USERS || "";
const allowedUsers = allowedUsersRaw.split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// --- GLOBAL VARIABLES ---
let targetNumbers = new Set(); // For Client A
let pendingSearches = new Map(); // For Client A
let onlineInterval = null; // For Client B
let ghostMode = true; // For Client B (Default: ON = Don't mark read)

// ============================================================================
//  CORE 1: CLIENT A (OTP HUNTER)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING) {
        console.log("⚠️ Client A (Hunter) skipped: No SESSION_STRING found.");
        return;
    }

    const clientA = new TelegramClient(sessionA, apiId, apiHash, { connectionRetries: 5 });
    await clientA.start({ onError: (err) => console.log("Client A Error:", err) });
    console.log("✅ Client A (Hunter) Online");

    // [Insert previous Database & Parsing functions here for Client A]
    // ... (Simplified for brevity, using the same logic as V4)
    // RE-ADDING THE FULL OTP LOGIC FOR CLIENT A BELOW:

    // --- DATABASE A ---
    async function backupDatabase() {
        try {
            const data = JSON.stringify([...targetNumbers], null, 2);
            const buffer = Buffer.from(data, 'utf8');
            buffer.name = "database_backup.json"; 
            await clientA.sendMessage("me", { message: "DB_BACKUP_DO_NOT_DELETE", file: buffer, forceDocument: true });
        } catch (e) { console.error("Backup A Error:", e); }
    }

    async function restoreDatabase() {
        try {
            const result = await clientA.getMessages("me", { search: "DB_BACKUP_DO_NOT_DELETE", limit: 1 });
            if (result && result.length > 0 && result[0].media) {
                const buffer = await clientA.downloadMedia(result[0], {});
                targetNumbers = new Set(JSON.parse(buffer.toString('utf8')));
                console.log(`[A] Restored ${targetNumbers.size} numbers.`);
            }
        } catch (e) { console.error("Restore A Error:", e); }
    }
    
    await restoreDatabase();

    // --- PARSING HELPERS ---
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

    // --- MONITORING A ---
    clientA.addEventHandler(async (event) => {
        const data = parseMsg(event.message);
        if (data) {
            // Check Active Searches
            for (const [real, info] of pendingSearches) {
                if (isMatch(real, data.number)) {
                    clearTimeout(info.timer);
                    pendingSearches.delete(real);
                    await clientA.sendMessage(info.chatId, { message: `[FOUND] Live Match\nOTP: \`${data.otp}\``, parseMode: "markdown" });
                    return;
                }
            }
            // Check Database
            for (const num of targetNumbers) {
                if (isMatch(num, data.number)) {
                    if (adminId) await clientA.sendMessage(adminId, { message: `[ALERT] Match: ${num}\nOTP: \`${data.otp}\``, parseMode: "markdown" });
                    break;
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

        if (txt === "/start") await msg.reply({ message: "HUNTER ACTIVE\n/save, /delete, /clear, /s <num>, /join <link>" });
        
        if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "Database wiped." }); }
        
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
                    minDate: Math.floor(Date.now()/1000)-1800, limit: 50
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
                    await msg.reply({ message: "Listening for 2 mins..." });
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
                if (txt === "/save") {
                    nums.forEach(n => targetNumbers.add(n));
                    await msg.reply({ message: `Added ${nums.length}. Total: ${targetNumbers.size}` });
                } else {
                    nums.forEach(n => targetNumbers.delete(n));
                    await msg.reply({ message: `Removed ${nums.length}.` });
                }
                await backupDatabase();
            }
        }
    }, new NewMessage({ incoming: true, outgoing: true }));
})();


// ============================================================================
//  CORE 2: CLIENT B (THE GHOST)
// ============================================================================
(async () => {
    if (!process.env.SESSION_STRING_B) {
        console.log("⚠️ Client B (Ghost) skipped: No SESSION_STRING_B found.");
        return;
    }

    const clientB = new TelegramClient(sessionB, apiId, apiHash, { connectionRetries: 5 });
    await clientB.start({ onError: (err) => console.log("Client B Error:", err) });
    console.log("✅ Client B (Ghost) Online");

    // --- GHOST / ONLINE LOGIC ---
    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        const txt = msg.text || "";

        // 1. AUTO-READ LOGIC (If Ghost Mode is OFF, mark everything read)
        if (!ghostMode && msg.incoming) {
            try {
                await clientB.markAsRead(msg.chatId);
            } catch (e) {}
        }

        // 2. COMMANDS (Only Owner or Allowed Users)
        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/start") {
            await msg.reply({ 
                message: "👻 GHOST SYSTEM\n\n" +
                         "/online on - Stay Online Forever\n" +
                         "/online off - Normal Status\n" +
                         "/ghost on - Don't mark read (Stealth)\n" +
                         "/ghost off - Auto mark read (Active)"
            });
        }

        // --- ONLINE TOGGLE ---
        if (txt === "/online on") {
            if (onlineInterval) clearInterval(onlineInterval);
            // Send 'Online' status every 3 minutes
            onlineInterval = setInterval(async () => {
                try {
                    await clientB.invoke(new Api.account.UpdateStatus({ offline: false }));
                } catch (e) { console.error("Online Ping Error:", e); }
            }, 180000); // 3 minutes
            
            await clientB.invoke(new Api.account.UpdateStatus({ offline: false }));
            await msg.reply({ message: "🟢 **Always Online** ACTIVATED." });
        }

        if (txt === "/online off") {
            if (onlineInterval) {
                clearInterval(onlineInterval);
                onlineInterval = null;
            }
            await clientB.invoke(new Api.account.UpdateStatus({ offline: true }));
            await msg.reply({ message: "🔴 **Always Online** DEACTIVATED." });
        }

        // --- GHOST TOGGLE ---
        if (txt === "/ghost on") {
            ghostMode = true;
            await msg.reply({ message: "👻 **Ghost Mode** ON. (I will not mark messages as read)" });
        }

        if (txt === "/ghost off") {
            ghostMode = false;
            await msg.reply({ message: "👀 **Ghost Mode** OFF. (I will auto-read incoming messages)" });
        }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
