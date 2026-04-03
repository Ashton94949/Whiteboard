document.addEventListener("DOMContentLoaded", () => {
    let socket = io("whiteboard-production-d685.up.railway.app", {
  transports: ["websocket", "polling"]
});
    let myUsername = ""; let myColor = ""; let currentChannel = "chat"; let pendingPassword = "";

    const authGate = document.getElementById("authGate"); const appContainer = document.getElementById("appContainer");
    const authSubmitBtn = document.getElementById("authSubmitBtn"); const authErrorMsg = document.getElementById("authErrorMsg");
    let isSignUpMode = false;

    let savedU = localStorage.getItem("wb_username"); let savedP = localStorage.getItem("wb_password");
    if (savedU && savedP) { pendingPassword = savedP; socket.emit("login", { username: savedU, password: savedP }); } 
    else { authGate.style.display = "flex"; }

    document.getElementById("showLoginBtn").onclick = function() { isSignUpMode = false; this.classList.add("active"); document.getElementById("showSignUpBtn").classList.remove("active"); document.getElementById("colorSelectGroup").style.display = "none"; authSubmitBtn.innerText = "Login"; authErrorMsg.style.display="none";};
    document.getElementById("showSignUpBtn").onclick = function() { isSignUpMode = true; this.classList.add("active"); document.getElementById("showLoginBtn").classList.remove("active"); document.getElementById("colorSelectGroup").style.display = "flex"; authSubmitBtn.innerText = "Sign Up"; authErrorMsg.style.display="none";};

    authSubmitBtn.onclick = () => {
        let u = document.getElementById("authUsername").value.trim(); let p = document.getElementById("authPassword").value.trim();
        if (!u || !p) { authErrorMsg.innerText = "Please fill all fields!"; authErrorMsg.style.display="block"; return; }
        pendingPassword = p;
        if (isSignUpMode) socket.emit("register", { username: u, password: p, color: document.getElementById("authColor").value });
        else socket.emit("login", { username: u, password: p });
    };

    socket.on("authError", (msg) => { authErrorMsg.innerText = msg; authErrorMsg.style.display="block"; authGate.style.display = "flex"; localStorage.removeItem("wb_username"); localStorage.removeItem("wb_password"); });
    socket.on("authSuccess", (data) => {
        myUsername = data.username; myColor = data.color;
        localStorage.setItem("wb_username", myUsername); localStorage.setItem("wb_password", pendingPassword);
        authGate.style.display = "none"; appContainer.style.display = "flex";
        document.getElementById("myNameDisplay").textContent = myUsername; document.getElementById("myAvatar").style.backgroundColor = myColor;
        document.getElementById("setNewUsername").value = myUsername; document.getElementById("setNewPassword").value = pendingPassword; document.getElementById("setNewColor").value = myColor;
        registerSocketEvents(); socket.emit("usernameJoined", { name: myUsername, color: myColor });
    });

    const settingsModal = document.getElementById("settingsModal");
    document.getElementById("openSettingsBtn").onclick = () => { document.getElementById("settingsErrorMsg").style.display = "none"; settingsModal.style.display = "flex"; };
    document.getElementById("closeSettingsBtn").onclick = () => settingsModal.style.display = "none";
    document.getElementById("logoutBtn").onclick = () => { localStorage.removeItem("wb_username"); localStorage.removeItem("wb_password"); window.location.reload(); };
    document.getElementById("saveSettingsBtn").onclick = () => {
        let nu = document.getElementById("setNewUsername").value.trim(); let np = document.getElementById("setNewPassword").value.trim(); let nc = document.getElementById("setNewColor").value;
        if (!nu || !np) return; pendingPassword = np; socket.emit("updateSettings", { newUsername: nu, newPassword: np, newColor: nc });
    };
    socket.on("settingsError", (msg) => { document.getElementById("settingsErrorMsg").innerText = msg; document.getElementById("settingsErrorMsg").style.display="block"; });
    socket.on("settingsSuccess", (data) => {
        myUsername = data.username; myColor = data.color;
        localStorage.setItem("wb_username", myUsername); localStorage.setItem("wb_password", pendingPassword);
        document.getElementById("myNameDisplay").textContent = myUsername; document.getElementById("myAvatar").style.backgroundColor = myColor;
        settingsModal.style.display = "none"; alert("Settings saved!");
    });

    document.querySelectorAll(".channel-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".channel-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); currentChannel = btn.dataset.target;
            document.getElementById("currentChannelTitle").textContent = btn.textContent;

            document.querySelectorAll(".content-area").forEach(area => area.classList.remove("active-area"));
            document.getElementById("whiteboardToolbar").style.display = "none";

            if (currentChannel === "whiteboard") { document.getElementById("whiteboardArea").classList.add("active-area"); document.getElementById("whiteboardToolbar").style.display = "flex"; drawCanvas(); } 
            else if (currentChannel === "document") document.getElementById("docArea").classList.add("active-area"); 
            else if (currentChannel === "games") document.getElementById("gamesArea").classList.add("active-area"); 
            else if (currentChannel === "ai") document.getElementById("aiArea").classList.add("active-area");
            else document.getElementById("chatArea").classList.add("active-area");
        });
    });

    document.getElementById("sharedDoc").addEventListener("input", (e) => socket.emit("updateDoc", e.target.value));

    // --- VECTOR WHITEBOARD ENGINE ---
    const canvas = document.getElementById("canvas"); const ctx = canvas.getContext("2d");
    let canvasObjects = []; let isDrawing = false; let activeTool = "pen"; let colorPicked = "#ffffff"; let lineWidth = 5;
    let draggingObject = null; let isResizing = false; let dragOffsetX = 0; let dragOffsetY = 0; let currentDrawingObj = null;

    const tools = { select: document.getElementById("selectButton"), pen: document.getElementById("penButton"), line: document.getElementById("lineButton"), square: document.getElementById("squareButton"), circle: document.getElementById("circleButton"), text: document.getElementById("textButton") };
    function setTool(tool) { activeTool = tool; Object.values(tools).forEach(b => b.classList.remove("active")); tools[tool].classList.add("active"); }
    Object.keys(tools).forEach(t => tools[t].addEventListener("click", () => setTool(t)));

    document.getElementById("colorInput").addEventListener("change", (e) => colorPicked = e.target.value);
    document.getElementById("widthSlider").addEventListener("input", (e) => { lineWidth = parseInt(e.target.value); document.getElementById("Size").textContent = lineWidth; });
    document.getElementById("clearCanvas").addEventListener("click", () => socket.emit("clearCanvas"));
    document.getElementById("undoButton").addEventListener("click", () => socket.emit("undoCanvas"));

    function getMousePos(e) {
        let rect = canvas.getBoundingClientRect(); let scaleX = canvas.width / rect.width; let scaleY = canvas.height / rect.height;
        return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
    }

    function drawCanvas() {
        ctx.fillStyle = "#36393f"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        canvasObjects.forEach(obj => {
            ctx.strokeStyle = obj.color; ctx.fillStyle = obj.color; ctx.lineWidth = obj.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
            if ((obj.type === "pen" || obj.type === "eraser") && obj.points && obj.points.length > 0) {
                ctx.beginPath(); ctx.moveTo(obj.points[0].x, obj.points[0].y); for(let i=1; i<obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y); ctx.stroke();
            } else if (obj.type === "line") { ctx.beginPath(); ctx.moveTo(obj.startX, obj.startY); ctx.lineTo(obj.endX, obj.endY); ctx.stroke();
            } else if (obj.type === "square") { ctx.strokeRect(obj.startX, obj.startY, obj.endX - obj.startX, obj.endY - obj.startY);
            } else if (obj.type === "circle") { ctx.beginPath(); let r = Math.hypot(obj.endX - obj.startX, obj.endY - obj.startY); ctx.arc(obj.startX, obj.startY, r, 0, Math.PI * 2); ctx.stroke();
            } else if (obj.type === "text") { ctx.font = `${obj.width * 5}px Arial`; ctx.fillText(obj.text, obj.startX, obj.startY);
            } else if (obj.type === "image") { 
                let img = new Image(); img.src = obj.src; 
                ctx.drawImage(img, obj.startX, obj.startY, obj.width, obj.height); 
                // Draw Resize Handle for images
                if (activeTool === "select") {
                    ctx.fillStyle = "rgba(88, 101, 242, 0.8)";
                    ctx.fillRect(obj.startX + obj.width - 15, obj.startY + obj.height - 15, 15, 15);
                }
            }
        });
    }

    function getClickedObject(x, y) {
        for (let i = canvasObjects.length - 1; i >= 0; i--) {
            let obj = canvasObjects[i];
            if (obj.type === "image") {
                // Check if clicked the resize handle (bottom-right 20x20 area)
                if (x >= obj.startX + obj.width - 20 && x <= obj.startX + obj.width + 10 && y >= obj.startY + obj.height - 20 && y <= obj.startY + obj.height + 10) return { obj: obj, action: "resize" };
                // Otherwise normal drag
                if (x >= obj.startX && x <= obj.startX + obj.width && y >= obj.startY && y <= obj.startY + obj.height) return { obj: obj, action: "drag" };
            }
            if (obj.type === "square" && x >= Math.min(obj.startX, obj.endX) && x <= Math.max(obj.startX, obj.endX) && y >= Math.min(obj.startY, obj.endY) && y <= Math.max(obj.startY, obj.endY)) return { obj: obj, action: "drag" };
            if (obj.type === "circle" && Math.hypot(x - obj.startX, y - obj.startY) <= Math.hypot(obj.endX - obj.startX, obj.endY - obj.startY)) return { obj: obj, action: "drag" };
            if (obj.type === "text" && x >= obj.startX && x <= obj.startX + (obj.text.length * obj.width * 3) && y <= obj.startY && y >= obj.startY - (obj.width * 5)) return { obj: obj, action: "drag" };
            if (obj.type === "line") { let d1 = Math.hypot(x - obj.startX, y - obj.startY); let d2 = Math.hypot(obj.endX - x, obj.endY - y); let len = Math.hypot(obj.endX - obj.startX, obj.endY - obj.startY); if (d1 + d2 >= len - 2 && d1 + d2 <= len + 2) return { obj: obj, action: "drag" }; }
            if ((obj.type === "pen" || obj.type === "eraser") && obj.points) {
                let minX = Math.min(...obj.points.map(p=>p.x)); let maxX = Math.max(...obj.points.map(p=>p.x)); let minY = Math.min(...obj.points.map(p=>p.y)); let maxY = Math.max(...obj.points.map(p=>p.y));
                if (x >= minX && x <= maxX && y >= minY && y <= maxY) return { obj: obj, action: "drag" };
            }
        } return null;
    }

    canvas.addEventListener("mousedown", (e) => {
        let pos = getMousePos(e);
        if (activeTool === "select") {
            let clicked = getClickedObject(pos.x, pos.y);
            if (clicked) { 
                draggingObject = clicked.obj; 
                isResizing = clicked.action === "resize";
                if(!isResizing) {
                    dragOffsetX = pos.x - (draggingObject.startX || draggingObject.points[0].x); 
                    dragOffsetY = pos.y - (draggingObject.startY || draggingObject.points[0].y); 
                }
            }
        } else if (activeTool === "text") {
            let text = prompt("Enter text:");
            if (text) { let obj = { id: Date.now() + Math.random().toString(), user: myUsername, type: "text", text: text, startX: pos.x, startY: pos.y, color: colorPicked, width: lineWidth }; canvasObjects.push(obj); drawCanvas(); socket.emit("canvasAdd", obj); }
        } else {
            isDrawing = true;
            currentDrawingObj = { id: Date.now() + Math.random().toString(), user: myUsername, type: activeTool, color: activeTool === "eraser" ? "#36393f" : colorPicked, width: lineWidth };
            if (activeTool === "pen" || activeTool === "eraser") currentDrawingObj.points = [pos];
            else { currentDrawingObj.startX = pos.x; currentDrawingObj.startY = pos.y; currentDrawingObj.endX = pos.x; currentDrawingObj.endY = pos.y; }
            canvasObjects.push(currentDrawingObj);
        }
    });

    document.addEventListener("mousemove", (e) => {
        let pos = getMousePos(e);
        if (draggingObject && activeTool === "select") {
            if (isResizing && draggingObject.type === "image") {
                let newWidth = pos.x - draggingObject.startX;
                let newHeight = pos.y - draggingObject.startY;
                if (newWidth > 20) draggingObject.width = newWidth;
                if (newHeight > 20) draggingObject.height = newHeight;
            } else {
                let dx = pos.x - dragOffsetX - (draggingObject.startX || draggingObject.points[0].x); let dy = pos.y - dragOffsetY - (draggingObject.startY || draggingObject.points[0].y);
                if (draggingObject.type === "pen" || draggingObject.type === "eraser") draggingObject.points.forEach(p => { p.x += dx; p.y += dy; });
                else { draggingObject.startX += dx; draggingObject.startY += dy; if (draggingObject.endX) { draggingObject.endX += dx; draggingObject.endY += dy; } }
                dragOffsetX = pos.x - (draggingObject.startX || draggingObject.points[0].x); dragOffsetY = pos.y - (draggingObject.startY || draggingObject.points[0].y);
            }
            drawCanvas(); socket.emit("canvasUpdate", draggingObject);
        } else if (isDrawing && currentDrawingObj) {
            if (activeTool === "pen" || activeTool === "eraser") currentDrawingObj.points.push(pos);
            else { currentDrawingObj.endX = pos.x; currentDrawingObj.endY = pos.y; }
            drawCanvas(); socket.emit("canvasUpdate", currentDrawingObj);
        }
    });

    document.addEventListener("mouseup", () => { if (isDrawing && currentDrawingObj) { isDrawing = false; currentDrawingObj = null; } if (draggingObject) draggingObject = null; isResizing = false;});

    document.addEventListener("paste", (e) => {
        if(currentChannel !== "whiteboard" && currentChannel !== "chat" && currentChannel !== "ai") return;
        let items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let index in items) {
            if (items[index].kind === 'file') {
                let reader = new FileReader();
                reader.onload = (event) => {
                    if (currentChannel === "whiteboard") {
                        let imgObj = { id: Date.now().toString(), user: myUsername, type: "image", src: event.target.result, startX: 50, startY: 50, width: 300, height: 300 };
                        canvasObjects.push(imgObj); drawCanvas(); socket.emit("canvasAdd", imgObj);
                    } else if (currentChannel === "chat") {
                        socket.emit("chatMessage", { text: `[IMG]${event.target.result}`, replyTo: replyToMessageId }); document.getElementById("replyBanner").style.display = "none"; replyToMessageId = null;
                    } else if (currentChannel === "ai") {
                        aiAttachedImage = event.target.result; document.getElementById("aiPreviewImg").src = aiAttachedImage; document.getElementById("aiImagePreview").style.display = "block";
                    }
                };
                reader.readAsDataURL(items[index].getAsFile());
            }
        }
    });

    // --- CHAT, EMOJIS, & GIFS ---
    const chatInput = document.getElementById("chatInput"); const chatMessages = document.getElementById("chatMessages");
    const typingIndicator = document.getElementById("typingIndicator"); const emojiModal = document.getElementById("emojiModal");
    const gifModal = document.getElementById("gifModal"); const gifResults = document.getElementById("gifResults");
    const reactionMenu = document.getElementById("reactionMenu");
    let replyToMessageId = null; let pendingReactionMsgId = null;

    const massiveEmojiList = ["😀","😁","😂","🤣","😃","😄","😅","😆","😉","😊","😋","😎","😍","😘","🥰","😗","😙","😚","☺️","🙂","🤗","🤩","🤔","🤨","😐","😑","😶","🙄","😏","😣","😥","😮","🤐","😯","😪","😫","🥱","😴","😌","😛","😜","😝","🤤","😒","😓","😔","😕","🙃","🤑","😲","☹️","🙁","😖","😞","😟","😤","😢","😭","😦","😧","😨","😩","🤯","😬","😰","😱","🥵","🥶","😳","🤪","😵","😡","😠","🤬","😷","🤒","🤕","🤢","🤮","🤧","😇","🥳","🥺","🤠","🤡","🤥","🤫","🤭","🧐","🤓","😈","👿","👹","👺","💀","👻","👽","🤖","💩","😺","😸","😹","😻","😼","😽","🙀","😿","😾","🙈","🙉","🙊","💋","💌","💘","💝","💖","💗","💓","💞","💕","💟","❣️","💔","❤️","🧡","💛","💚","💙","💜","🤎","🖤","🤍","💯","💢","💥","💫","💦","💨","🕳️","💣","💬","👁️‍🗨️","🗨️","🗯️","💭","💤","👋","🤚","🖐️","✋","🖖","👌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏"];
    massiveEmojiList.forEach(e => {
        let btn = document.createElement("button"); btn.className = "emoji-item"; btn.innerText = e;
        btn.onclick = () => { chatInput.value += e; emojiModal.style.display = "none"; chatInput.focus(); };
        document.getElementById("emojiGrid").appendChild(btn);
    });

    document.getElementById("emojiBtn").addEventListener("click", () => emojiModal.style.display = "flex");
    document.getElementById("closeEmojiModal").addEventListener("click", () => emojiModal.style.display = "none");
    document.getElementById("gifBtn").addEventListener("click", () => { gifModal.style.display = "flex"; socket.emit("searchGIFs", "trending"); });
    document.getElementById("closeGifModal").addEventListener("click", () => gifModal.style.display = "none");

    let gifTimeout;
    document.getElementById("gifSearchInput").addEventListener("input", (e) => {
        clearTimeout(gifTimeout); gifTimeout = setTimeout(() => { socket.emit("searchGIFs", e.target.value.trim() || "trending"); }, 500);
    });

    document.querySelectorAll(".react-opt").forEach(btn => {
        btn.addEventListener("click", (e) => { if (pendingReactionMsgId) socket.emit("addReaction", { msgId: pendingReactionMsgId, emoji: e.target.innerText }); reactionMenu.style.display = "none"; });
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".reaction-menu") && !e.target.closest(".react-btn")) reactionMenu.style.display = "none"; });

    let typingTimeout;
    chatInput.addEventListener("input", () => { socket.emit("typing", true); clearTimeout(typingTimeout); typingTimeout = setTimeout(() => socket.emit("typing", false), 2000); });
    document.getElementById("chatSendButton").addEventListener("click", sendChatMessage);
    chatInput.addEventListener("keypress", (e) => { if (e.key === "Enter") sendChatMessage(); });

    function sendChatMessage() {
        let msg = chatInput.value.trim();
        if (msg) { socket.emit("chatMessage", { text: msg, replyTo: replyToMessageId }); chatInput.value = ""; socket.emit("typing", false); document.getElementById("replyBanner").style.display = "none"; replyToMessageId = null; }
    }
    document.getElementById("cancelReplyBtn").addEventListener("click", () => { document.getElementById("replyBanner").style.display = "none"; replyToMessageId = null; });

    function applyMarkdownAndMath(element, text) {
        element.innerHTML = marked.parse(text);
        renderMathInElement(element, {
            delimiters: [ {left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false} ],
            throwOnError: false
        });
    }

    function createMessageElement(data) {
        const msgEl = document.createElement("div"); msgEl.className = `message msg-${data.id}`; 
        if (data.isSystem) { msgEl.classList.add("system-message"); msgEl.textContent = data.text; } 
        else {
            if (data.text.includes(`@${myUsername}`)) msgEl.classList.add("mention-highlight");
            if (data.replyTo) { let replyDiv = document.createElement("div"); replyDiv.className = "reply-reference"; replyDiv.textContent = `↪ Replying to @${data.replyTo.user}: ${data.replyTo.text}`; msgEl.appendChild(replyDiv); }
            let contentWrap = document.createElement("div"); contentWrap.className = "msg-content-wrapper";

            let safeName = data.user || "Unknown";
            let initial = safeName.length > 0 ? safeName.charAt(0).toUpperCase() : "?";

            let avatar = document.createElement("div"); avatar.className = "msg-avatar"; avatar.style.backgroundColor = data.color || "#5865F2"; avatar.textContent = data.bot ? "🤖" : initial;
            let bodyDiv = document.createElement("div"); bodyDiv.className = "msg-body";
            let headerDiv = document.createElement("div"); headerDiv.className = "msg-header";
            let nameStrong = document.createElement("span"); nameStrong.className = "msg-username"; nameStrong.textContent = safeName; nameStrong.style.color = data.color || "#ffffff";
            if (data.bot) { let botTag = document.createElement("span"); botTag.className = "bot-tag"; botTag.textContent = "BOT"; nameStrong.appendChild(botTag); }
            headerDiv.appendChild(nameStrong); bodyDiv.appendChild(headerDiv);

            if(data.text.startsWith("[GIF]")) {
                let img = document.createElement("img"); img.src = `/proxy-media?url=${encodeURIComponent(data.text.replace("[GIF]", "").trim())}`; img.className = "chat-gif"; bodyDiv.appendChild(img);
            } else if(data.text.startsWith("[IMG]")) {
                let img = document.createElement("img"); img.src = data.text.replace("[IMG]", "").trim(); img.className = "chat-img"; bodyDiv.appendChild(img);
            } else {
                let textSpan = document.createElement("div"); textSpan.className = "msg-text markdown-body";
                applyMarkdownAndMath(textSpan, data.text);
                bodyDiv.appendChild(textSpan);
            }

            let actions = document.createElement("div"); actions.className = "msg-actions";
            let reactBtn = document.createElement("button"); reactBtn.className = "react-btn"; reactBtn.innerHTML = "😀"; 
            reactBtn.onclick = (e) => { pendingReactionMsgId = data.id; reactionMenu.style.left = `${e.pageX - 50}px`; reactionMenu.style.top = `${e.pageY + 10}px`; reactionMenu.style.display = "flex"; };
            let replyBtn = document.createElement("button"); replyBtn.innerHTML = "↩️"; 
            replyBtn.onclick = () => { replyToMessageId = { id: data.id, user: safeName, text: data.text.substring(0, 40) }; document.getElementById("replyToName").textContent = `@${safeName}`; document.getElementById("replyBanner").style.display = "flex"; chatInput.focus(); };
            actions.appendChild(reactBtn); actions.appendChild(replyBtn);
            if (safeName === myUsername && !data.bot) { let delBtn = document.createElement("button"); delBtn.innerHTML = "🗑️"; delBtn.onclick = () => socket.emit("deleteMessage", data.id); actions.appendChild(delBtn); }
            msgEl.appendChild(actions);

            let reactionsBox = document.createElement("div"); reactionsBox.className = "reactions-box"; reactionsBox.id = `react-${data.id}`;
            if (data.reactions) {
                for (let [emoji, reactData] of Object.entries(data.reactions)) {
                    let rBadge = document.createElement("span"); rBadge.className = "reaction-badge"; 
                    if (reactData.users.includes(myUsername)) rBadge.classList.add("reacted-by-me");
                    rBadge.textContent = `${emoji} ${reactData.count}`; rBadge.onclick = () => socket.emit("addReaction", { msgId: data.id, emoji: emoji }); reactionsBox.appendChild(rBadge);
                }
            }
            bodyDiv.appendChild(reactionsBox); contentWrap.appendChild(avatar); contentWrap.appendChild(bodyDiv); msgEl.appendChild(contentWrap);
        } return msgEl;
    }

    function timeSince(date) {
        let seconds = Math.floor((new Date() - date) / 1000); let interval = seconds / 31536000; if (interval > 1) return Math.floor(interval) + "y ago";
        interval = seconds / 2592000; if (interval > 1) return Math.floor(interval) + "mo ago"; interval = seconds / 86400; if (interval > 1) return Math.floor(interval) + "d ago";
        interval = seconds / 3600; if (interval > 1) return Math.floor(interval) + "h ago"; interval = seconds / 60; if (interval > 1) return Math.floor(interval) + "m ago"; return "Just now";
    }

    // --- AI CHAT (Vision Paste Support) ---
    let aiAttachedImage = null;
    document.getElementById("clearAiImgBtn").onclick = () => { aiAttachedImage = null; document.getElementById("aiImagePreview").style.display = "none"; };

    document.getElementById("aiSendButton").onclick = () => {
        let prompt = document.getElementById("aiInput").value.trim();
        if(!prompt && !aiAttachedImage) return;

        let msgBox = document.getElementById("aiMessages");
        let html = `<div class="message"><div class="msg-content-wrapper"><div class="msg-avatar" style="background:#5865F2">${myUsername.charAt(0)}</div><div class="msg-body"><div class="msg-header"><span class="msg-username" style="color:#fff">${myUsername}</span></div>`;
        if(prompt) html += `<div class="msg-text">${prompt}</div>`;
        if(aiAttachedImage) html += `<img src="${aiAttachedImage}" class="chat-img" style="max-width:200px; margin-top:5px;">`;
        html += `</div></div></div>`;

        msgBox.innerHTML += html; document.getElementById("aiInput").value = ""; msgBox.scrollTop = msgBox.scrollHeight;
        socket.emit("askAI", { prompt: prompt, image: aiAttachedImage });
        document.getElementById("clearAiImgBtn").click(); 
    };

    socket.on("aiResponse", (text) => {
        let msgBox = document.getElementById("aiMessages");
        let div = document.createElement("div"); div.className = "message";
        let content = `<div class="msg-content-wrapper"><div class="msg-avatar" style="background:#10a37f">🤖</div><div class="msg-body"><div class="msg-header"><span class="msg-username" style="color:#10a37f">ChatGPT</span></div><div class="msg-text markdown-body"></div></div></div>`;
        div.innerHTML = content;
        applyMarkdownAndMath(div.querySelector(".msg-text"), text);
        msgBox.appendChild(div);
        msgBox.scrollTop = msgBox.scrollHeight;
    });

    // --- GAMES ---
    const tttBoard = document.getElementById("tttBoard");
    if(tttBoard) { for(let i=0; i<9; i++) { let cell = document.createElement("div"); cell.className = "ttt-cell"; cell.id = `ttt-${i}`; cell.onclick = () => socket.emit("playTTT", i); tttBoard.appendChild(cell); } }
    if(document.getElementById("tttP1Btn")) document.getElementById("tttP1Btn").onclick = () => socket.emit("joinTTT", "X");
    if(document.getElementById("tttP2Btn")) document.getElementById("tttP2Btn").onclick = () => socket.emit("joinTTT", "O");
    if(document.getElementById("tttBotBtn")) document.getElementById("tttBotBtn").onclick = () => socket.emit("joinTTTBot");
    if(document.getElementById("tttResetBtn")) document.getElementById("tttResetBtn").onclick = () => socket.emit("resetTTT");

    const c4Board = document.getElementById("c4Board");
    if(c4Board) { for (let r=0; r<6; r++) { for (let c=0; c<7; c++) { let cell = document.createElement("div"); cell.className = "c4-cell"; cell.id = `c4-${r}-${c}`; cell.onclick = () => socket.emit("playC4", c); c4Board.appendChild(cell); } } }
    if(document.getElementById("c4P1Btn")) document.getElementById("c4P1Btn").onclick = () => socket.emit("joinC4", "Red");
    if(document.getElementById("c4P2Btn")) document.getElementById("c4P2Btn").onclick = () => socket.emit("joinC4", "Yellow");
    if(document.getElementById("c4BotBtn")) document.getElementById("c4BotBtn").onclick = () => socket.emit("joinC4Bot");
    if(document.getElementById("c4ResetBtn")) document.getElementById("c4ResetBtn").onclick = () => socket.emit("resetC4");

    if(document.getElementById("bjJoinBtn")) document.getElementById("bjJoinBtn").onclick = () => socket.emit("bjJoin");
    if(document.getElementById("bjStartBtn")) document.getElementById("bjStartBtn").onclick = () => socket.emit("bjStart");
    if(document.getElementById("bjHitBtn")) document.getElementById("bjHitBtn").onclick = () => socket.emit("bjHit");
    if(document.getElementById("bjStandBtn")) document.getElementById("bjStandBtn").onclick = () => socket.emit("bjStand");

    const soundUrls = { vineboom: "https://www.myinstants.com/media/sounds/vine-boom.mp3", airhorn: "https://www.myinstants.com/media/sounds/mlg-airhorn.mp3", fart: "https://www.myinstants.com/media/sounds/fart-with-reverb.mp3", bruh: "https://www.myinstants.com/media/sounds/movie_1.mp3" };
    function playRealSound(type) { if (soundUrls[type]) { let audio = new Audio(`/proxy-media?url=${encodeURIComponent(soundUrls[type])}`); audio.play().catch(e => console.log("Audio block:", e)); } }
    document.querySelectorAll(".sound-btn").forEach(btn => { btn.onclick = () => { let s = btn.dataset.sound; playRealSound(s); socket.emit("playSound", s); }; });

    function registerSocketEvents() {
        socket.on("loadCanvas", (objs) => { canvasObjects = objs || []; drawCanvas(); });
        socket.on("canvasAdd", (obj) => { canvasObjects.push(obj); drawCanvas(); });
        socket.on("canvasUpdate", (obj) => { const i = canvasObjects.findIndex(o => o.id === obj.id); if (i !== -1) { canvasObjects[i] = obj; drawCanvas(); } });
        socket.on("clearCanvas", () => { canvasObjects = []; drawCanvas(); });

        socket.on("loadChatHistory", (history) => { chatMessages.innerHTML = ""; history.forEach(msg => chatMessages.appendChild(createMessageElement(msg))); chatMessages.scrollTop = chatMessages.scrollHeight; });
        socket.on("chatMessage", (data) => { if (document.querySelector(`.msg-${data.id}`)) return; chatMessages.appendChild(createMessageElement(data)); chatMessages.scrollTop = chatMessages.scrollHeight; });
        socket.on("messageDeleted", (msgId) => document.querySelectorAll(`.msg-${msgId}`).forEach(el => el.remove()));

        socket.on("updateReactions", ({ msgId, reactions }) => {
            let box = document.getElementById(`react-${msgId}`);
            if (box) {
                box.innerHTML = "";
                for (let [emoji, reactData] of Object.entries(reactions)) {
                    let rBadge = document.createElement("span"); rBadge.className = "reaction-badge"; 
                    if (reactData.users.includes(myUsername)) rBadge.classList.add("reacted-by-me");
                    rBadge.textContent = `${emoji} ${reactData.count}`; rBadge.onclick = () => socket.emit("addReaction", { msgId: msgId, emoji: emoji }); box.appendChild(rBadge);
                }
            }
        });

        let typists = new Set();
        socket.on("userTyping", (data) => {
            if (data.isTyping) typists.add(data.name); else typists.delete(data.name);
            typingIndicator.textContent = typists.size > 0 ? `${Array.from(typists).join(", ")} typing...` : "";
        });

        socket.on("loadDoc", (text) => {
            let sharedDoc = document.getElementById("sharedDoc");
            if (sharedDoc.value !== text) { const start = sharedDoc.selectionStart; const end = sharedDoc.selectionEnd; sharedDoc.value = text; if (document.activeElement === sharedDoc) sharedDoc.setSelectionRange(start, end); }
        });

        const profilePopup = document.getElementById("userProfilePopup");
        socket.on("userListUpdate", users => { 
            let onlineList = document.getElementById("onlineUsersList"); onlineList.innerHTML = `<h3 class="members-header">ONLINE — ${users.filter(u=>u.status==='online').length}</h3>`; 
            let offlineList = document.getElementById("offlineUsersList"); offlineList.innerHTML = `<h3 class="members-header" style="margin-top:20px;">OFFLINE — ${users.filter(u=>u.status==='offline').length}</h3>`; 

            users.forEach(u => {
                let div = document.createElement("div"); div.className = "user-badge-discord"; 
                if (u.status === "offline") div.classList.add("offline-user"); 
                let av = document.createElement("div"); av.className = "user-avatar-small"; av.style.backgroundColor = u.color; av.textContent = u.name.charAt(0).toUpperCase();
                let name = document.createElement("span"); name.textContent = u.name; name.style.color = u.color;
                div.appendChild(av); div.appendChild(name);

                div.onclick = (e) => {
                    document.getElementById("profileHeader").style.backgroundColor = u.color; document.getElementById("profileName").textContent = u.name;
                    document.getElementById("profileStatus").textContent = u.status === "online" ? "🟢 Online Now" : "⚪ Offline";
                    document.getElementById("profileLastSeen").textContent = u.status === "offline" ? `Last seen: ${timeSince(u.lastOnline)}` : "";
                    profilePopup.style.left = `${e.pageX - 250}px`; profilePopup.style.top = `${e.pageY}px`; profilePopup.style.display = "block";
                };

                if (u.status === 'online') onlineList.appendChild(div); else offlineList.appendChild(div);
            });
        });

        document.addEventListener("click", (e) => { if (!e.target.closest(".profile-popup") && !e.target.closest(".user-badge-discord")) profilePopup.style.display = "none"; });

        socket.on("gifResults", (results) => {
            gifResults.innerHTML = ""; if (!results || results.length === 0) return gifResults.innerHTML = "<p>No GIFs found.</p>";
            results.forEach(gif => {
                const img = document.createElement("img"); img.src = `/proxy-media?url=${encodeURIComponent(gif.media[0].tinygif.url)}`; img.className = "gif-result";
                img.onclick = () => { socket.emit("chatMessage", { text: `[GIF]${gif.media[0].gif.url}`, replyTo: replyToMessageId }); document.getElementById("replyBanner").style.display = "none"; replyToMessageId = null; gifModal.style.display = "none"; };
                gifResults.appendChild(img);
            });
        });

        socket.on("tttUpdate", (data) => {
            let trnDisp = document.getElementById("tttTurnDisplay");
            if(trnDisp) {
                if (data.winner) {
                    let wName = data.winner === "X" ? data.pX : data.pO;
                    trnDisp.textContent = data.winner === "Draw" ? "Game is a Draw!" : `${wName} Wins! 🎉`;
                } else trnDisp.textContent = `Turn: ${data.turn}`;
            }
            if(document.getElementById("tttNameX")) document.getElementById("tttNameX").textContent = `X: ${data.pX || "?"}`;
            if(document.getElementById("tttNameO")) document.getElementById("tttNameO").textContent = `O: ${data.pO || "?"}`;
            data.state.forEach((val, i) => { let c = document.getElementById(`ttt-${i}`); if(c) c.textContent = val || ""; });
        });

        socket.on("c4Update", (data) => {
            let trnDisp = document.getElementById("c4TurnDisplay");
            if(trnDisp) {
                if (data.winner) {
                    let wName = data.winner === "Red" ? data.pRed : data.pYellow;
                    trnDisp.textContent = data.winner === "Draw" ? "Game is a Draw!" : `${wName} Wins! 🎉`;
                    trnDisp.style.color = data.winner === "Red" ? "#ff4d4f" : (data.winner === "Yellow" ? "#f1c40f" : "#fff");
                } else {
                    trnDisp.textContent = `Turn: ${data.turn}`;
                    trnDisp.style.color = data.turn === "Red" ? "#ff4d4f" : "#f1c40f";
                }
            }
            if(document.getElementById("c4NameRed")) document.getElementById("c4NameRed").textContent = `Red: ${data.pRed || "?"}`;
            if(document.getElementById("c4NameYellow")) document.getElementById("c4NameYellow").textContent = `Yellow: ${data.pYellow || "?"}`;
            for (let r=0; r<6; r++) {
                for (let c=0; c<7; c++) {
                    let cell = document.getElementById(`c4-${r}-${c}`);
                    if(cell) {
                        if (data.state[r][c] === "Red") cell.style.backgroundColor = "#ff4d4f";
                        else if (data.state[r][c] === "Yellow") cell.style.backgroundColor = "#f1c40f";
                        else cell.style.backgroundColor = "var(--bg-tertiary)";
                    }
                }
            }
        });

        socket.on("bjUpdate", (state) => {
            let bjStat = document.getElementById("bjStatusText");
            if(bjStat) bjStat.textContent = state.message;

            let dDiv = document.getElementById("dealerCards"); 
            if(dDiv) {
                dDiv.innerHTML = "";
                if (state.dealerHand) {
                    state.dealerHand.forEach((c, i) => { 
                        let d = document.createElement("div"); d.className="bj-card"; 
                        if(['♥','♦'].includes(c.suit)) d.style.color = "#e74c3c";
                        if(state.state === "playing" && i === 1) d.textContent = "🂠"; else d.textContent = `${c.val}${c.suit}`; 
                        dDiv.appendChild(d); 
                    });
                }
            }

            let pArea = document.getElementById("bjPlayersArea");
            if(pArea) {
                pArea.innerHTML = "";
                if (state.players) {
                    state.players.forEach((p, idx) => {
                        let wrapper = document.createElement("div"); wrapper.style.background = "var(--bg-primary)"; wrapper.style.padding = "10px"; wrapper.style.borderRadius = "8px"; wrapper.style.textAlign = "center";

                        // Highlight if waiting on this player
                        if(state.state === "playing" && p.status === "playing") wrapper.style.border = "2px solid #f1c40f";

                        let title = document.createElement("h4"); title.style.color = "white"; title.textContent = `${p.name} ${p.result ? `(${p.result})` : ''}`;
                        let handDiv = document.createElement("div"); handDiv.className = "card-area";
                        if (p.hand) {
                            p.hand.forEach(c => { 
                                let d = document.createElement("div"); d.className="bj-card"; 
                                if(['♥','♦'].includes(c.suit)) d.style.color = "#e74c3c";
                                d.textContent = `${c.val}${c.suit}`; handDiv.appendChild(d); 
                            });
                        }
                        wrapper.appendChild(title); wrapper.appendChild(handDiv); pArea.appendChild(wrapper);
                    });
                }
            }
        });

        socket.on("playSound", (s) => playRealSound(s));
    }
});
