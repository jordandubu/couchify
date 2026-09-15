const $ = (id) => document.getElementById(id);

let currentContext = "normal";

async function initContext() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentContext = tab?.incognito ? "private" : "normal";
  } catch {
    currentContext = "normal";
  }
}

async function currentRoom() {
  return browser.runtime.sendMessage({ type: "status", context: currentContext });
}

// Tab Switching (Create / Join)
const tabCreate = $("tabCreate");
const tabJoin = $("tabJoin");
const panelCreate = $("panelCreate");
const panelJoin = $("panelJoin");

tabCreate.addEventListener("click", () => {
  tabCreate.classList.add("active");
  tabJoin.classList.remove("active");
  panelCreate.style.display = "block";
  panelJoin.style.display = "none";
});

tabJoin.addEventListener("click", () => {
  tabJoin.classList.add("active");
  tabCreate.classList.remove("active");
  panelJoin.style.display = "block";
  panelCreate.style.display = "none";
  $("joinCode").focus();
});

// Render UI based on connection & room status
function render(status) {
  const dot = $("statusDot");
  const statusText = $("statusText");
  const idleView = $("idleView");
  const roomView = $("roomView");
  const peerCountEl = $("peerCount");
  const policyBadgeEl = $("policyBadge");
  const codeEl = $("code");
  const roomStatusEl = $("roomStatus");

  const isConnected = !!status.connected;
  dot.className = `status-dot ${isConnected ? "connected" : "disconnected"}`;

  if (status.room) {
    statusText.textContent = isConnected ? "Connected" : "Reconnecting";
    idleView.style.display = "none";
    roomView.style.display = "block";

    codeEl.textContent = status.room;
    roomStatusEl.textContent = isConnected ? "Synced" : "Connecting";

    const count = status.peerCount || 1;
    peerCountEl.textContent = `${count} ${count === 1 ? "watcher" : "watchers"}`;
    peerCountEl.className = "tag online";

    policyBadgeEl.textContent = status.policy === "both" ? "All control" : "Leader only";
  } else {
    statusText.textContent = isConnected ? "Ready" : "Disconnected";
    idleView.style.display = "block";
    roomView.style.display = "none";
  }
}

async function refresh() {
  try {
    const status = await currentRoom();
    render(status);
  } catch {}
}

// Create Room Action
$("create").addEventListener("click", async () => {
  const createBtn = $("create");
  createBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({
      type: "create-room",
      policy: $("policy").value,
      context: currentContext,
    });
    render({ connected: true, room: res.room, policy: res.policy, peerCount: 1 });
  } finally {
    createBtn.disabled = false;
  }
});

// Join Room Action
async function handleJoin() {
  const codeInput = $("joinCode");
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) return;

  const joinBtn = $("join");
  joinBtn.disabled = true;
  try {
    await browser.runtime.sendMessage({
      type: "join-room",
      code,
      context: currentContext,
    });
    await refresh();
  } finally {
    joinBtn.disabled = false;
  }
}

$("join").addEventListener("click", handleJoin);
$("joinCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleJoin();
});

// Leave Room Action
$("leave").addEventListener("click", async () => {
  await browser.runtime.sendMessage({
    type: "leave-room",
    context: currentContext,
  });
  await refresh();
});

// Copy Room Code Button
$("copyBtn").addEventListener("click", () => {
  const code = $("code").textContent.trim();
  if (!code || code === "------") return;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $("copyBtn");
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1500);
  }).catch(() => {});
});

// Live Updates: peer count & mismatch banners
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "peer-count") {
    const peerCountEl = $("peerCount");
    if (peerCountEl) {
      const count = msg.count || 1;
      peerCountEl.textContent = `${count} ${count === 1 ? "watcher" : "watchers"}`;
    }
  }
  if (msg.type === "region-mismatch") {
    $("bannerRegion").textContent = msg.text;
    $("bannerRegion").className = `banner ${msg.level}`;
  }
  if (msg.type === "title-mismatch") {
    $("bannerTitle").textContent = msg.text;
    $("bannerTitle").className = "banner red";
  }
});

(async () => {
  await initContext();
  await refresh();
  setInterval(refresh, 3000);
})();