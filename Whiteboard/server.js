const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const https = require("https");
const path = require("path");
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  maxHttpBufferSize: 1e8,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, "public")));

// --- MONGODB CLOUD DATABASE SETUP ---
if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI is missing! Please set it in your Render Environment Variables.");
    process.exit(1);
}

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

// Global Memory Variables
let users = {}; let currentDocState = ""; let chatHistory = []; let canvasObjects = []; let accounts = {}; 

async function initDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db('workspace');
        
        // 1. Load Accounts
        const accs = await db.collection('accounts').find({}).toArray();
        accs.forEach(a => accounts[a.username] = a.data);

        // 2. Load Chat History (Limit to 500 newest)
        chatHistory = await db.collection('chat').find({}).sort({$natural: -1}).limit(500).toArray();
        chatHistory = chatHistory.reverse();

        // 3. Load Canvas
        canvasObjects = await db.collection('canvas').find({}).toArray();

        // 4. Load Document
        const docNode = await db.collection('doc').findOne({ id: "main" });
        if(docNode) currentDocState = docNode.text;

        console.log("✅ MongoDB Successfully Connected & Loaded!");
    } catch (e) {
        console.error("❌ MongoDB Connection Error:", e);
    }
}

// Database Helper Functions (Replaces old fs.writeFileSync logic)
function saveAccountDB(username, data) { if(db) db.collection('accounts').updateOne({ username }, { $set: { data } }, { upsert: true }); }
function deleteAccountDB(username) { if(db) db.collection('accounts').deleteOne({ username }); }
function insertChatDB(msg) { if(db) db.collection('chat').insertOne(msg); }
function updateChatReactionsDB(msgId, reactions) { if(db) db.collection('chat').updateOne({ id: msgId }, { $set: { reactions } }); }
function deleteChatDB(msgId) { if(db) db.collection('chat').deleteOne({ id: msgId }); }
function insertCanvasDB(obj) { if(db) db.collection('canvas').insertOne(obj); }
function updateCanvasDB(obj) { if(db) db.collection('canvas').updateOne({ id: obj.id }, { $set: obj }); }
function removeCanvasDB(objId) { if(db) db.collection('canvas').deleteOne({ id: objId }); }
function clearCanvasDB() { if(db) db.collection('canvas').deleteMany({}); }
function saveDocDB(text) { if(db) db.collection('doc').updateOne({ id: "main" }, { $set: { text } }, { upsert: true }); }

// --- MEDIA PROXY ---
app.get("/proxy-media", (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL");
    const client = targetUrl.startsWith("https") ? https : http;
    const request = client.get(targetUrl, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            let newUrl = proxyRes.headers.location;
            if (!newUrl.startsWith("http")) newUrl = new URL(targetUrl).origin + newUrl;
            return res.redirect(`/proxy-media?url=${encodeURIComponent(newUrl)}`);
        }
        res.setHeader("Cache-Control", "public, max-age=31536000");
        proxyRes.pipe(res);
    });
    request.on("error", () => res.status(500).send("Proxy error"));
});

// --- GAMES STATE ---
let ttt = { state: Array(9).fill(null), turn: "X", winner: null, pX: null, pO: null, isBot: false };
let c4 = { state: Array(6).fill(null).map(()=>Array(7).fill(null)), turn: "Red", winner: null, pRed: null, pYellow: null, isBot: false };
let bj = { state: "waiting", players: [], dealerHand: [], message: "Waiting for players to join..." };
const bjDeckTemplate = [];
['♠','♥','♦','♣'].forEach(suit => { ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].forEach(val => bjDeckTemplate.push({suit, val})); });
let currentDeck = [];

function calcBJScore(hand) {
    let score = 0; let aces = 0;
    hand.forEach(c => { if(c.val==='A') { aces++; score+=11; } else if(['J','Q','K'].includes(c.val)) score+=10; else score+=parseInt(c.val); });
    while(score > 21 && aces > 0) { score-=10; aces--; } return score;
}
function drawCard() { return currentDeck.pop(); }

function checkBJRoundOver() {
    let allDone = bj.players.every(p => p.status !== "playing");
    if (allDone) {
        bj.state = "dealerTurn";
        let dScore = calcBJScore(bj.dealerHand);
        while(dScore < 17) { bj.dealerHand.push(drawCard()); dScore = calcBJScore(bj.dealerHand); }

        bj.players.forEach(p => {
            if (p.status === "bust") p.result = "Lose";
            else if (dScore > 21) p.result = "Win";
            else if (p.score > dScore) p.result = "Win";
            else if (p.score < dScore) p.result = "Lose";
            else p.result = "Push";
        });
        bj.message = dScore > 21 ? `Dealer busts with ${dScore}!` : `Dealer stands on ${dScore}.`;
        bj.state = "over";
    }
    io.emit("bjUpdate", bj);
}

function getSafeUserList() {
    const active = Object.values(users).map(u => u.name);
    return Object.keys(accounts).map(u => ({ name: u, color: accounts[u].color, status: active.includes(u) ? "online" : "offline", lastOnline: accounts[u].lastOnline }));
}

function checkTTTWin(b) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (let l of lines) if (b[l[0]] && b[l[0]]===b[l[1]] && b[l[0]]===b[l[2]]) return b[l[0]];
    if (b.every(c => c !== null)) return "Draw"; return null;
}
function checkC4Win(b) {
    for (let r=0; r<6; r++) for (let c=0; c<7; c++) {
        let p = b[r][c]; if (!p) continue;
        if (c+3<7 && b[r][c+1]===p && b[r][c+2]===p && b[r][c+3]===p) return p;
        if (r+3<6 && b[r+1][c]===p && b[r+2][c]===p && b[r+3][c]===p) return p;
        if (r+3<6 && c+3<7 && b[r+1][c+1]===p && b[r+2][c+2]===p && b[r+3][c+3]===p) return p;
        if (r+3<6 && c-3>=0 && b[r+1][c-1]===p && b[r+2][c-2]===p && b[r+3][c-3]===p) return p;
    }
    if (b[0].every(c => c !== null)) return "Draw"; return null;
}
function minimax(board, depth, isMax) {
    let res = checkTTTWin(board);
    if (res === "O") return 10 - depth; if (res === "X") return depth - 10; if (res === "Draw") return 0;
    if (isMax) { let best = -Infinity; for (let i=0; i<9; i++) { if (!board[i]) { board[i] = "O"; best = Math.max(best, minimax(board, depth+1, false)); board[i] = null; } } return best; } 
    else { let best = Infinity; for (let i=0; i<9; i++) { if (!board[i]) { board[i] = "X"; best = Math.min(best, minimax(board, depth+1, true)); board[i] = null; } } return best; }
}
function botTTTMove() {
    let bestScore = -Infinity; let move;
    for (let i=0; i<9; i++) { if (!ttt.state[i]) { ttt.state[i] = "O"; let score = minimax(ttt.state, 0, false); ttt.state[i] = null; if (score > bestScore) { bestScore = score; move = i; } } }
    if (move !== undefined) { ttt.state[move] = "O"; ttt.winner = checkTTTWin(ttt.state); if (!ttt.winner) ttt.turn = "X"; }
}
function getC4DropRow(b, c) { for(let r=5; r>=0; r--) if(!b[r][c]) return r; return -1; }
function botC4Move() {
    for(let c=0; c<7; c++) { let r = getC4DropRow(c4.state, c); if(r!==-1) { c4.state[r][c] = "Yellow"; if(checkC4Win(c4.state)==="Yellow") { c4.winner = "Yellow"; return; } c4.state[r][c] = null; } }
    for(let c=0; c<7; c++) { let r = getC4DropRow(c4.state, c); if(r!==-1) { c4.state[r][c] = "Red"; if(checkC4Win(c4.state)==="Red") { c4.state[r][c] = "Yellow"; if(!checkC4Win(c4.state)) c4.turn = "Red"; return; } c4.state[r][c] = null; } }
    let pref = [3, 2, 4, 1, 5, 0, 6]; for(let c of pref) { let r = getC4DropRow(c4.state, c); if(r!==-1) { c4.state[r][c] = "Yellow"; c4.turn = "Red"; return; } }
}

io.on("connection", (socket) => {
    socket.on("register", (data) => {
        let u = data.username.trim(); if (accounts[u]) return socket.emit("authError", "Username already exists!");
        accounts[u] = { password: data.password, color: data.color, status: "online", lastOnline: Date.now() }; 
        saveAccountDB(u, accounts[u]); 
        socket.emit("authSuccess", { username: u, color: data.color });
    });

    socket.on("login", (data) => {
        let u = data.username.trim(); if (!accounts[u] || accounts[u].password !== data.password) return socket.emit("authError", "Invalid login or session expired!");
        socket.emit("authSuccess", { username: u, color: accounts[u].color });
    });

    socket.on("updateSettings", (data) => {
        if (!socket.username) return socket.emit("authError", "Session expired.");
        let oldU = socket.username; let newU = data.newUsername.trim();
        if (newU !== oldU && accounts[newU]) return socket.emit("settingsError", "Taken!");
        
        accounts[newU] = { password: data.newPassword, color: data.newColor, status: "online", lastOnline: Date.now() };
        if (newU !== oldU) {
            delete accounts[oldU];
            deleteAccountDB(oldU);
        }
        saveAccountDB(newU, accounts[newU]);

        socket.username = newU; socket.userColor = data.newColor; users[socket.id] = { name: newU, color: data.newColor };
        io.emit("userListUpdate", getSafeUserList()); socket.emit("settingsSuccess", { username: newU, color: data.newColor });
    });

    socket.on("usernameJoined", (data) => {
        socket.username = data.name.trim(); socket.userColor = data.color; users[socket.id] = { name: socket.username, color: socket.userColor }; 
        if(accounts[socket.username]) { 
            accounts[socket.username].status = "online"; 
            saveAccountDB(socket.username, accounts[socket.username]);
        }
        io.emit("userListUpdate", getSafeUserList()); 
        
        const joinMsg = { id: Date.now().toString(), user: "System", text: `${socket.username} joined.`, isSystem: true };
        io.emit("chatMessage", joinMsg);

        socket.emit("loadCanvas", canvasObjects); socket.emit("loadDoc", currentDocState); socket.emit("loadChatHistory", chatHistory);
        socket.emit("tttUpdate", { state: ttt.state, turn: ttt.turn, winner: ttt.winner, pX: ttt.pX, pO: ttt.pO }); 
        socket.emit("c4Update", { state: c4.state, turn: c4.turn, winner: c4.winner, pRed: c4.pRed, pYellow: c4.pYellow }); 
        socket.emit("bjUpdate", bj);
    });

    socket.on("chatMessage", (data) => {
        if (!socket.username) return socket.emit("authError", "Session expired. Please log in again.");
        if (!data || !data.text) return; let text = data.text; if (!text.startsWith("[IMG]") && text.length > 500) text = text.substring(0, 500);

        if (text.startsWith("/")) {
            let reply = ""; const cmd = text.split(" ")[0].toLowerCase(); const args = text.substring(cmd.length).trim();
            if (cmd === "/roll") reply = `🎲 **${socket.username}** rolled a **${Math.floor(Math.random()*100)+1}**!`;
            else if (cmd === "/flip") reply = `🪙 **${socket.username}** flipped a coin and got **${Math.random()>0.5?"Heads":"Tails"}**!`;
            else if (cmd === "/8ball") reply = `🎱 8-Ball answers **${socket.username}**: "Maybe."`;
            else if (cmd === "/calc") { try { reply = `🧮 ${args} = **${Function('return ' + args.replace(/[^0-9+\-*/().]/g, ''))()}**`; } catch(e) { reply = "❌ Math Error"; } }
            if (reply !== "") { 
                const sm = { id: Date.now()+"sys", user: "Server Bot", color: "#5865F2", text: reply, isSystem: false, bot: true, reactions: {} }; 
                chatHistory.push(sm); if(chatHistory.length>500) chatHistory.shift(); 
                insertChatDB(sm);
                io.emit("chatMessage", sm); 
                return; 
            }
        }
        const msg = { id: Date.now()+Math.random().toString().substr(2,5), user: socket.username, color: socket.userColor, text: text, isSystem: false, replyTo: data.replyTo, reactions: {} };
        chatHistory.push(msg); if(chatHistory.length>500) chatHistory.shift(); 
        insertChatDB(msg);
        io.emit("chatMessage", msg);
    });

    socket.on("addReaction", ({ msgId, emoji }) => {
        if (!socket.username) return;
        const msg = chatHistory.find(m => m.id === msgId);
        if (msg) {
            if (!msg.reactions) msg.reactions = {};
            if (msg.reactions[emoji] && msg.reactions[emoji].users.includes(socket.username)) {
                msg.reactions[emoji].count--; msg.reactions[emoji].users = msg.reactions[emoji].users.filter(u => u !== socket.username);
                if (msg.reactions[emoji].count <= 0) delete msg.reactions[emoji];
            } else {
                if (!msg.reactions[emoji]) msg.reactions[emoji] = { count: 0, users: [] };
                msg.reactions[emoji].count++; msg.reactions[emoji].users.push(socket.username);
            }
            updateChatReactionsDB(msgId, msg.reactions);
            io.emit("updateReactions", { msgId, reactions: msg.reactions });
        }
    });

    socket.on("deleteMessage", (msgId) => { 
        if(!socket.username) return; 
        let i = chatHistory.findIndex(m => m.id === msgId); 
        // ADMIN CHECK
        if (i !== -1 && (chatHistory[i].user === socket.username || socket.username === "Ashton94949")) { 
            chatHistory.splice(i, 1); 
            deleteChatDB(msgId);
            io.emit("messageDeleted", msgId); 
        } 
    });

    socket.on("typing", (isTyping) => { if (socket.username) socket.broadcast.emit("userTyping", { name: socket.username, isTyping }); });

    // --- AI PROXY ---
    socket.on("askAI", (data) => {
        if (!socket.username) return socket.emit("authError", "Session expired. Please log in again.");
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return socket.emit("aiResponse", "❌ **Server Error:** The `OPENAI_API_KEY` is missing in Render Environment Variables.");

        let messages = [
            { role: "system", content: "You are a helpful AI assistant. IMPORTANT: ALWAYS format math equations using double dollar signs `$$` for block math, and single dollar signs `$` for inline math. Do NOT use \\[ or \\] or \\( or \\). Format code blocks using standard markdown." }
        ];

        if (data.image) messages.push({ role: "user", content: [ { type: "text", text: data.prompt || "Describe this image." }, { type: "image_url", image_url: { url: data.image } } ] });
        else messages.push({ role: "user", content: data.prompt });

        const postData = JSON.stringify({ model: "gpt-4o", messages: messages });
        const options = {
            hostname: 'api.openai.com', port: 443, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(postData) }
        };

        const req = https.request(options, (res) => {
            let body = ''; res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.error) socket.emit("aiResponse", `❌ **OpenAI API Error:** ${result.error.message}`);
                    else if (result.choices && result.choices.length > 0) socket.emit("aiResponse", result.choices[0].message.content);
                    else socket.emit("aiResponse", "❌ Unknown error: Received empty response from OpenAI.");
                } catch (e) { socket.emit("aiResponse", "❌ Server Error: Failed to parse AI response."); }
            });
        });
        req.on('error', (e) => socket.emit("aiResponse", "❌ Server Error connecting to OpenAI servers."));
        req.write(postData); req.end();
    });

    // --- GAMES ---
    socket.on("joinTTT", (player) => { if(!socket.username) return; ttt[player === "X" ? "pX" : "pO"] = socket.username; io.emit("tttUpdate", ttt); });
    socket.on("joinTTTBot", () => { if(!socket.username) return; ttt.pO = "Bot 🤖"; ttt.isBot = true; io.emit("tttUpdate", ttt); });
    socket.on("playTTT", (i) => {
        if (!socket.username || ttt.winner || ttt.state[i] !== null) return;
        if ((ttt.turn === "X" && ttt.pX !== socket.username) || (ttt.turn === "O" && ttt.pO !== socket.username)) return; 
        ttt.state[i] = ttt.turn; ttt.winner = checkTTTWin(ttt.state);
        if (!ttt.winner) { ttt.turn = ttt.turn === "X" ? "O" : "X"; if (ttt.isBot && ttt.turn === "O") botTTTMove(); }
        io.emit("tttUpdate", ttt);
    });
    socket.on("resetTTT", () => { ttt = { state: Array(9).fill(null), turn: "X", winner: null, pX: null, pO: null, isBot: false }; io.emit("tttUpdate", ttt); });

    socket.on("joinC4", (player) => { if(!socket.username) return; c4[player === "Red" ? "pRed" : "pYellow"] = socket.username; io.emit("c4Update", c4); });
    socket.on("joinC4Bot", () => { if(!socket.username) return; c4.pYellow = "Bot 🤖"; c4.isBot = true; io.emit("c4Update", c4); });
    socket.on("playC4", (col) => {
        if (!socket.username || c4.winner) return;
        if ((c4.turn === "Red" && c4.pRed !== socket.username) || (c4.turn === "Yellow" && c4.pYellow !== socket.username)) return;
        for (let r=5; r>=0; r--) {
            if (c4.state[r][col] === null) {
                c4.state[r][col] = c4.turn; c4.winner = checkC4Win(c4.state);
                if (!c4.winner) { c4.turn = c4.turn === "Red" ? "Yellow" : "Red"; if (c4.isBot && c4.turn === "Yellow") botC4Move(); }
                io.emit("c4Update", c4); break;
            }
        }
    });
    socket.on("resetC4", () => { c4 = { state: Array(6).fill(null).map(()=>Array(7).fill(null)), turn: "Red", winner: null, pRed: null, pYellow: null, isBot: false }; io.emit("c4Update", c4); });

    // Blackjack Multiplayer
    socket.on("bjJoin", () => {
        if (!socket.username || (bj.state !== "waiting" && bj.state !== "over")) return;
        if (!bj.players.find(p => p.name === socket.username)) {
            bj.players.push({ name: socket.username, hand: [], status: "waiting", score: 0, result: "" });
            bj.message = `${socket.username} joined the table.`; io.emit("bjUpdate", bj);
        }
    });
    socket.on("bjStart", () => {
        if (!socket.username || bj.players.length === 0) return;
        currentDeck = [...bjDeckTemplate, ...bjDeckTemplate, ...bjDeckTemplate].sort(() => Math.random() - 0.5); 
        bj.dealerHand = [drawCard(), drawCard()];
        bj.players.forEach(p => { 
            p.hand = [drawCard(), drawCard()]; p.score = calcBJScore(p.hand); 
            p.status = p.score === 21 ? "blackjack" : "playing"; p.result = ""; 
        });
        bj.state = "playing"; bj.message = "Game started! Everyone hit or stand.";
        checkBJRoundOver();
    });
    socket.on("bjHit", () => {
        if (!socket.username || bj.state !== "playing") return;
        let p = bj.players.find(pl => pl.name === socket.username);
        if (!p || p.status !== "playing") return;
        p.hand.push(drawCard()); p.score = calcBJScore(p.hand);
        if (p.score > 21) p.status = "bust";
        checkBJRoundOver();
    });
    socket.on("bjStand", () => {
        if (!socket.username || bj.state !== "playing") return;
        let p = bj.players.find(pl => pl.name === socket.username);
        if (!p || p.status !== "playing") return;
        p.status = "stand"; checkBJRoundOver();
    });

    socket.on("playSound", (s) => { if(socket.username) socket.broadcast.emit("playSound", s); });

    // --- CANVAS & DOC ---
    socket.on("canvasAdd", (obj) => { 
        if(!socket.username) return; 
        canvasObjects.push(obj); 
        insertCanvasDB(obj); 
        socket.broadcast.emit("canvasAdd", obj); 
    });
    socket.on("canvasUpdate", (obj) => { 
        if(!socket.username) return; 
        const i = canvasObjects.findIndex(o => o.id === obj.id); 
        if (i !== -1) { 
            canvasObjects[i] = obj; 
            updateCanvasDB(obj); 
            socket.broadcast.emit("canvasUpdate", obj); 
        } 
    });
    socket.on("clearCanvas", () => { 
        if(!socket.username) return; 
        canvasObjects = []; 
        clearCanvasDB(); 
        io.emit("clearCanvas"); 
    });
    
    socket.on("undoCanvas", () => {
        if(!socket.username) return;
        for (let i = canvasObjects.length - 1; i >= 0; i--) {
            if (canvasObjects[i].user === socket.username) {
                let removed = canvasObjects.splice(i, 1)[0];
                removeCanvasDB(removed.id);
                io.emit("loadCanvas", canvasObjects);
                break;
            }
        }
    });

    socket.on("updateDoc", (t) => { 
        if(!socket.username) return; 
        currentDocState = t; 
        saveDocDB(t); 
        socket.broadcast.emit("loadDoc", t); 
    });
    
    socket.on("searchGIFs", (q) => {
        https.get(`https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=LIVDSRZULELA&limit=16`, (res) => {
            let body = ""; res.on("data", chunk => body += chunk);
            res.on("end", () => { try { socket.emit("gifResults", JSON.parse(body).results || []); } catch(err) { socket.emit("gifResults", []); } });
        }).on("error", () => socket.emit("gifResults", []));
    });

    socket.on("disconnect", () => {
        if (socket.username && accounts[socket.username]) {
            accounts[socket.username].status = "offline"; 
            accounts[socket.username].lastOnline = Date.now(); 
            saveAccountDB(socket.username, accounts[socket.username]); 
            delete users[socket.id];
            
            io.emit("userListUpdate", getSafeUserList()); 
            io.emit("chatMessage", { id: Date.now().toString(), user: "System", text: `${socket.username} disconnected.`, isSystem: true });
        }
    });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
    server.listen(PORT, () => console.log(`[SERVER] Running on Port ${PORT}`));
});
