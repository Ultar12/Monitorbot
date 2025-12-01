require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require('express');

// --- 1. SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Dual Core System Active (V6)'));
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
let pendingSearches = new Map(); // Key: Suffix (Last 4 digits), Value: { chatId, timer, fullNumber }
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

    // --- HELPER FUNCTIONS ---
    
    function extractNumbers(text) {
        const regex = /(?:\+|)\d{7,15}/g;
        const matches = text.match(regex);
        return matches ? matches.map(n => n.replace(/\+/g, '')) : [];
    }

    // Handles ⁕, ⁎, ∗, •, ●
    function normalizeMask(input) { 
        return input.replace(/[\u2055\u204E\u2217\u2022\u25CF]/g, '*'); 
    }

    // Checks if the Msg Number matches our Search Query
    function isMatch(queryNum, msgMaskedNum) {
        const cleanMasked = normalizeMask(msgMaskedNum).replace(/[^0-9*]/g, '');
        const cleanQuery = queryNum.replace(/[^0-9]/g, '');

        // Case 1: Query is short (suffix only, e.g. "5870")
        if (cleanQuery.length < 7) {
            return cleanMasked.endsWith(cleanQuery);
        }

        // Case 2: Query is full number (e.g. "2347012345870")
        // Check if masked number fits inside the query
        if (cleanMasked.includes('*')) {
            const parts = cleanMasked.split('*').filter(x => x.length > 0);
            if (parts.length < 1) return false; // Too masked to tell
            
            const prefix = parts[0];
            const suffix = parts[parts.length - 1];
            
            return cleanQuery.startsWith(prefix) && cleanQuery.endsWith(suffix);
        }

        // Exact match
        return cleanQuery === cleanMasked;
    }

    // Aggressively extracts OTP and Number from a message
    function parseMsg(message) {
        if (!message) return null;
        
        // 1. Combine Main Text + Button Text
        let txt = message.message || "";
        if (message.replyMarkup && message.replyMarkup.rows) {
            message.replyMarkup.rows.forEach(r => r.buttons && r.buttons.forEach(b => { if (b.text) txt += " " + b.text; }));
        }
        if (txt.length < 5) return null;

        // 2. Find OTP (Any 6 digit number, maybe split by - or space)
        // Matches: "123456", "123-456", "123 456"
        // Avoids matching phone numbers by ensuring boundaries
        const otpRegex = /(?:^|\s|\n|:|-)([\d]{3}[-\s]?[\d]{3})(?:$|\s|\n)/;
        
        // 3. Find Masked Number
        // Looks for at least 3 digits, then some * or ⁕, then at least 3 digits
        // Example: 234***567, 234⁕⁕⁕567
        const numRegex = /([0-9]{3,}[*\u2055\u204E\u2217\u2022\u25CF]+[0-9]{3,})/;

        const o = txt.match(otpRegex);
        const n = txt.match(numRegex);

        if (o && n) {
            return { 
                otp: o[1].replace(/[-\s]/g, '').trim(), // Clean OTP
                number: n[0].trim() 
            };
        }
        return null;
    }

    // --- MONITORING (Passive + Active) ---
    clientA.addEventHandler(async (event) => {
        const data = parseMsg(event.message);
        
        if (data) {
            const suffix = data.number.replace(/[^0-9]/g, '').slice(-4); // Get last 4 digits of masked num

            // 1. ACTIVE SEARCH CHECK
            // We check if we are looking for this specific suffix
            if (pendingSearches.has(suffix)) {
                const searchInfo = pendingSearches.get(suffix);
                
                // Double check match
                if (isMatch(searchInfo.fullNumber, data.number)) {
                    clearTimeout(searchInfo.timer);
                    pendingSearches.delete(suffix);
                    
                    await clientA.sendMessage(searchInfo.chatId, { 
                        message: `[FOUND] Live Match\nSource: ${data.number}\nOTP Below:` 
                    });
                    await clientA.sendMessage(searchInfo.chatId, { 
                        message: `\`${data.otp}\``, 
                        parseMode: "markdown" 
                    });
                    return;
                }
            }

            // 2. PASSIVE DATABASE CHECK
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

        if (txt === "/start") await msg.reply({ message: "HUNTER ONLINE (V6)\n/s <num or last4>, /save, /delete, /clear, /join <link>" });
        if (txt === "/clear") { targetNumbers.clear(); await backupDatabase(); await msg.reply({ message: "DB wiped." }); }
        
        if (txt.startsWith("/join ")) {
            try {
                let h = txt.split(" ")[1].replace(/https:\/\/t\.me\/(\+|joinchat\/)/, "");
                await clientA.invoke(new Api.messages.ImportChatInvite({ hash: h }));
                await msg.reply({ message: "Joined." });
            } catch (e) { await msg.reply({ message: "Error: " + e.message }); }
        }

        // --- /s COMMAND (SEARCH) ---
        if (txt.startsWith("/s ")) {
            const rawQuery = txt.split(" ")[1];
            if (!rawQuery) return await msg.reply({ message: "Usage: /s 5870 or /s +234..." });

            const cleanQuery = rawQuery.replace(/\D/g, '');
            const suffix = cleanQuery.slice(-4); // Always search by last 4 digits
            const chatId = msg.chatId;

            await msg.reply({ message: `Searching history (10m) for *${suffix}*...`, parseMode: 'markdown' });

            try {
                // 1. Search Global History (Last 10 mins)
                const res = await clientA.invoke(new Api.messages.SearchGlobal({
                    q: suffix, 
                    filter: new Api.InputMessagesFilterEmpty(),
                    minDate: Math.floor(Date.now()/1000) - 600, // 10 minutes ago
                    limit: 50,
                    offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, folderId: 0, maxDate: 0
                }));

                let found = false;
                if (res.messages) {
                    for (const m of res.messages) {
                        const d = parseMsg(m);
                        if (d && isMatch(cleanQuery, d.number)) {
                            await msg.reply({ message: `[HISTORY] Source: ${d.number}\nOTP: \`${d.otp}\``, parseMode: "markdown" });
                            found = true; break;
                        }
                    }
                }

                if (found) return; // Stop if found in history

                // 2. Active Listen (1 Minute)
                await msg.reply({ message: `Not in history. Listening for 1 minute...` });
                
                const timer = setTimeout(() => {
                    if (pendingSearches.has(suffix)) { 
                        pendingSearches.delete(suffix); 
                        clientA.sendMessage(chatId, { message: `[TIMEOUT] Search ended for *${suffix}*.`, parseMode: 'markdown' }); 
                    }
                }, 60000); // 60 seconds

                // Store search request
                pendingSearches.set(suffix, { chatId, timer, fullNumber: cleanQuery });

            } catch (e) { await msg.reply({ message: "Search Error: " + e.message }); }
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

    async function keepOnline() {
        try { await clientB.invoke(new Api.account.UpdateStatus({ offline: false })); } catch (e) {}
    }

    clientB.addEventHandler(async (event) => {
        const msg = event.message;
        const sender = msg.senderId ? Number(msg.senderId) : null;
        const txt = msg.text || "";

        if (!ghostMode && msg.incoming) { try { await clientB.markAsRead(msg.chatId); } catch (e) {} }
        if (!msg.out && !allowedUsers.includes(sender)) return;

        if (txt === "/start") await msg.reply({ message: "GHOST ONLINE\n/online on/off\n/ghost on/off" });

        if (txt === "/online on") {
            if (onlineInterval) clearInterval(onlineInterval);
            onlineInterval = setInterval(keepOnline, 60000); 
            await keepOnline();
            await msg.reply({ message: "🟢 Always Online: ACTIVE" });
        }

        if (txt === "/online off") {
            if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; }
            await clientB.invoke(new Api.account.UpdateStatus({ offline: true }));
            await msg.reply({ message: "🔴 Always Online: OFF" });
        }

        if (txt === "/ghost on") { ghostMode = true; await msg.reply({ message: "👻 Ghost Mode: ON" }); }
        if (txt === "/ghost off") { ghostMode = false; await msg.reply({ message: "👀 Ghost Mode: OFF" }); }

    }, new NewMessage({ incoming: true, outgoing: true }));
})();
