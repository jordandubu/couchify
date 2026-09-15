// Couchify background service worker: MQTT lifecycle over WebSockets,
// dual-session support (normal vs private window isolation),
// presence & live peer count tracking, and video synchronization.

import { DEFAULT_RELAY_URL, decode, encode, makePeerId, makeRoomCode } from "../lib/protocol.js";
import mqtt from "mqtt";

class RoomSession {
  constructor(contextId) {
    this.contextId = contextId; // "normal" | "private"
    this.peerId = makePeerId() + (contextId === "private" ? "_p" : "_n");
    this.room = null; // { code, policy, leaderId }
    this.client = null;
    this.clientConnected = false;
    this.lastContentState = null;
    this.lastLeaderState = null;
    this.lastKnownVideoHref = null;
    this.lastVideoTabId = null;
    this.shouldAutoOpenTab = false;
    this.pendingEmits = [];
    this.activePeers = new Map(); // peerId -> lastSeenTimestamp
    this.presenceTimer = null;
  }

  isLeader() {
    if (!this.room) return false;
    return !this.room.leaderId || this.room.leaderId === this.peerId;
  }

  getRole() {
    if (!this.room) return "both";
    if (this.room.policy !== "leader") return "both";
    return this.isLeader() ? "leader" : "follower";
  }

  topic(code) {
    return `couchify/v1/room/${code}`;
  }

  presenceTopic(code) {
    return `couchify/v1/room/${code}/presence`;
  }

  getPeerCount() {
    return this.activePeers.size + 1;
  }

  notifyPeerCount() {
    notifyContent(this, { type: "peer-count", count: this.getPeerCount() });
  }

  connect(url) {
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }
    this.clientConnected = false;

    console.log(`[couchify:${this.contextId}] connecting to broker:`, url);
    try {
      this.client = mqtt.connect(url, {
        clientId: `cf_${this.peerId}`,
        keepalive: 30,
        reconnectPeriod: 2500,
      });
    } catch (err) {
      console.error(`[couchify:${this.contextId}] mqtt.connect failed:`, err);
      return;
    }

    this.client.on("connect", () => {
      console.log(`[couchify:${this.contextId}] connected to broker:`, url);
      this.clientConnected = true;
      if (this.room) {
        this.subscribeRoom(this.room.code);
      }
      this.flushPending();
      broadcastRoomState(this);
    });

    this.client.on("close", () => {
      this.clientConnected = false;
      broadcastRoomState(this);
    });

    this.client.on("error", (err) => {
      console.warn(`[couchify:${this.contextId}] broker error:`, err.message);
    });

    this.client.on("message", (topic, payload) => {
      const raw = payload.toString();
      if (!raw) return;
      if (topic.endsWith("/presence")) {
        try {
          const data = JSON.parse(raw);
          this.handlePresence(data);
        } catch {}
        return;
      }
      const wire = decode(raw);
      if (!wire) return;
      this.handleWire(wire);
    });
  }

  subscribeRoom(code) {
    if (!this.client || !this.clientConnected) return;
    const roomT = this.topic(code);
    const presT = this.presenceTopic(code);

    this.client.subscribe([roomT, presT], { qos: 0 }, (err) => {
      if (err) {
        console.error(`[couchify:${this.contextId}] subscribe error:`, err);
        return;
      }
      console.log(`[couchify:${this.contextId}] subscribed to room & presence:`, code);
      this.sendRaw(encode({ kind: "sync-request", room: code, from: this.peerId, ts: Date.now() }));
      this.startPresence();
    });
  }

  startPresence() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.broadcastPresence("ping");
    this.presenceTimer = setInterval(() => {
      if (this.room && this.clientConnected) {
        this.broadcastPresence("ping");
        this.prunePeers();
      }
    }, 3000);
  }

  broadcastPresence(op = "ping") {
    if (this.room && this.client && this.clientConnected) {
      this.client.publish(
        this.presenceTopic(this.room.code),
        JSON.stringify({ op, from: this.peerId, ts: Date.now() }),
        { qos: 0 }
      );
    }
  }

  handlePresence(data) {
    if (!data || !data.from || data.from === this.peerId) return;
    if (data.op === "leave") {
      this.activePeers.delete(data.from);
      this.notifyPeerCount();
      return;
    }
    const isNew = !this.activePeers.has(data.from);
    this.activePeers.set(data.from, Date.now());
    if (isNew) {
      this.broadcastPresence("ping");
    }
    this.notifyPeerCount();
  }

  prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [pid, lastSeen] of this.activePeers) {
      if (now - lastSeen > 8000) {
        this.activePeers.delete(pid);
        changed = true;
      }
    }
    if (changed) this.notifyPeerCount();
  }

  sendRaw(raw, retain = false) {
    if (this.room && this.client && this.clientConnected) {
      this.client.publish(this.topic(this.room.code), raw, { qos: 0, retain });
    }
  }

  flushPending() {
    while (this.pendingEmits.length) this.sendRaw(this.pendingEmits.shift());
  }

  handleWire(msg) {
    if (!this.room || msg.room !== this.room.code) return;

    if (msg.leader && (!this.room.leaderId || this.room.leaderId !== msg.leader)) {
      this.room.leaderId = msg.leader;
      if (msg.policy) this.room.policy = msg.policy;
      broadcastRoomState(this);
    }

    // Auto-open on initial join if not already open
    if (msg.state?.href && this.shouldAutoOpenTab) {
      this.shouldAutoOpenTab = false;
      this.lastKnownVideoHref = msg.state.href;
      openVideoInWindow(this.contextId, msg.state.href);
    }

    if (msg.from === this.peerId) return; // ignore our own messages for playback sync

    if (msg.kind === "sync-request") {
      notifyContent(this, { type: "sync-request", from: msg.from });
      return;
    }

    // Leader-only filter: if room policy is leader, only accept playback & navigation from the leader
    if (this.room.policy === "leader" && msg.from !== this.room.leaderId) return;

    // Track leader's state and follow video changes
    if (msg.state?.href) {
      this.lastLeaderState = { ...msg.state, ts: msg.ts || Date.now() };

      // If the host navigated to a different video, follow host!
      if (this.lastKnownVideoHref && !isSameVideo(this.lastKnownVideoHref, msg.state.href)) {
        console.log(`[couchify:${this.contextId}] leader changed video, following to:`, msg.state.href);
        this.lastKnownVideoHref = msg.state.href;
        followVideoInWindow(this.contextId, msg.state.href);
      } else if (!this.lastKnownVideoHref) {
        this.lastKnownVideoHref = msg.state.href;
      }
    }

    notifyContent(this, { type: "peer-msg", raw: encode(msg) });
  }

  leaveRoom() {
    this.shouldAutoOpenTab = false;
    this.lastLeaderState = null;
    this.lastKnownVideoHref = null;
    this.lastVideoTabId = null;
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.room && this.client && this.clientConnected) {
      this.broadcastPresence("leave");
      this.client.unsubscribe([this.topic(this.room.code), this.presenceTopic(this.room.code)]);
    }
    this.activePeers.clear();
    this.room = null;
    broadcastRoomState(this);
  }
}

// Separate normal and private window sessions so local testing works seamlessly
const sessions = {
  normal: new RoomSession("normal"),
  private: new RoomSession("private"),
};

function getSession(contextId) {
  return sessions[contextId] || sessions.normal;
}

async function relayUrl() {
  const isObsolete = (u) => !u || u === "ws://localhost:8080" || u.includes("couchify.relay");
  try {
    const v = await browser.storage.local.get({ relayUrl: null });
    if (v?.relayUrl && !isObsolete(v.relayUrl)) return v.relayUrl;
  } catch {}
  try {
    const v = await browser.storage.sync.get({ relayUrl: null });
    if (v?.relayUrl && !isObsolete(v.relayUrl)) return v.relayUrl;
  } catch {}
  return DEFAULT_RELAY_URL;
}

// Connect both sessions on startup
relayUrl().then((url) => {
  sessions.normal.connect(url);
  sessions.private.connect(url);
});

function getYouTubeVideoId(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/shorts/")) {
        return u.pathname.split("/")[2] || null;
      }
      return u.searchParams.get("v") || null;
    }
    if (u.hostname === "youtu.be") {
      return u.pathname.replace(/^\//, "") || null;
    }
  } catch {}
  return null;
}

function getUrlTimestamp(urlStr) {
  try {
    const u = new URL(urlStr);
    const t = u.searchParams.get("t");
    if (!t) return 0;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    let seconds = 0;
    const h = t.match(/(\d+)h/);
    const m = t.match(/(\d+)m/);
    const s = t.match(/(\d+)s/);
    if (h) seconds += parseInt(h[1], 10) * 3600;
    if (m) seconds += parseInt(m[1], 10) * 60;
    if (s) seconds += parseInt(s[1], 10);
    return seconds;
  } catch {
    return 0;
  }
}

function isSameVideo(a, b) {
  if (!a || !b) return false;
  try {
    const yt1 = getYouTubeVideoId(a);
    const yt2 = getYouTubeVideoId(b);
    if (yt1 || yt2) {
      return yt1 === yt2;
    }

    const u1 = new URL(a);
    const u2 = new URL(b);
    if (u1.origin !== u2.origin) return false;
    if (u1.pathname !== u2.pathname) return false;
    return true;
  } catch {
    return a === b;
  }
}

function isVideoDomain(url) {
  if (!url) return false;
  return /youtube\.com|netflix\.com|max\.com|primevideo\.com|disneyplus\.com/i.test(url);
}

function followVideoInWindow(contextId, targetHref) {
  if (!targetHref || !targetHref.startsWith("http")) return;
  const isPriv = contextId === "private";
  const session = getSession(contextId);

  browser.tabs.query({}).then((tabs) => {
    const matching = tabs.filter((t) => !t.incognito === isPriv);

    // 1. If user is ALREADY on this exact video, do not re-navigate or duplicate
    const alreadyOnVideo = matching.find((t) => t.url && isSameVideo(t.url, targetHref));
    if (alreadyOnVideo) {
      session.lastVideoTabId = alreadyOnVideo.id;
      if (!alreadyOnVideo.active) {
        browser.tabs.update(alreadyOnVideo.id, { active: true }).catch(() => {});
      }
      return;
    }

    // 2. Find target tab to navigate:
    // Priority a: previous video tab
    let targetTab = null;
    if (session.lastVideoTabId) {
      targetTab = matching.find((t) => t.id === session.lastVideoTabId);
    }

    // Priority b: active tab in this window
    if (!targetTab) {
      targetTab = matching.find((t) => t.active);
    }

    // Priority c: any tab on a video site
    if (!targetTab) {
      targetTab = matching.find((t) => t.url && isVideoDomain(t.url));
    }

    if (targetTab) {
      console.log(`[couchify:${contextId}] following host: navigating tab ${targetTab.id} to ${targetHref}`);
      session.lastVideoTabId = targetTab.id;
      browser.tabs.update(targetTab.id, { url: targetHref, active: true }).catch(() => {});
    } else {
      console.log(`[couchify:${contextId}] following host: opening new tab with ${targetHref}`);
      browser.tabs.create({ url: targetHref, active: true }).then((newTab) => {
        session.lastVideoTabId = newTab.id;
      }).catch(() => {});
    }
  }).catch((err) => console.error("[couchify] followVideo error:", err));
}

function openVideoInWindow(contextId, targetHref) {
  followVideoInWindow(contextId, targetHref);
}

function notifyContent(session, msg) {
  const isPriv = session.contextId === "private";
  browser.tabs.query({}).then((tabs) => {
    for (const t of tabs) {
      if (!t.incognito === isPriv) {
        browser.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    }
  });
}

function broadcastRoomState(session) {
  notifyContent(session, {
    type: "room-state",
    joined: !!session.room,
    role: session.getRole(),
    peerId: session.peerId,
    lastLeaderState: session.lastLeaderState || null,
  });
}

// Clean up closed tabs
browser.tabs.onRemoved.addListener((tabId) => {
  for (const session of Object.values(sessions)) {
    if (session.lastVideoTabId === tabId) {
      session.lastVideoTabId = null;
    }
  }
});

// Follow host when host navigates tab directly
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !changeInfo.url.startsWith("http")) return;
  const contextId = tab.incognito ? "private" : "normal";
  const session = getSession(contextId);
  if (!session.room) return;

  // Only the host / leader (or "both") triggers room navigation
  if (session.getRole() === "follower") return;

  // If this tab was the known video tab or active tab
  if (session.lastVideoTabId && session.lastVideoTabId !== tabId) return;

  if (!isSameVideo(session.lastKnownVideoHref, changeInfo.url)) {
    console.log(`[couchify:${contextId}] leader tab navigated to:`, changeInfo.url);
    session.lastKnownVideoHref = changeInfo.url;
    session.lastVideoTabId = tabId;

    const startPos = getUrlTimestamp(changeInfo.url);
    const raw = encode({
      kind: "state",
      ts: Date.now(),
      room: session.room.code,
      from: session.peerId,
      policy: session.room.policy,
      leader: session.room.leaderId,
      state: {
        href: changeInfo.url,
        position: startPos,
        playing: true,
        rate: 1.0,
        action: true,
      },
    });
    session.sendRaw(raw, true);
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const contextId = message.context || (sender.tab?.incognito ? "private" : "normal");
  const session = getSession(contextId);

  switch (message.type) {
    case "get-room-state": {
      if (sender.tab?.id) session.lastVideoTabId = sender.tab.id;
      sendResponse({
        joined: !!session.room,
        role: session.getRole(),
        peerId: session.peerId,
        room: session.room?.code || null,
        policy: session.room?.policy || null,
        lastLeaderState: session.lastLeaderState || null,
      });
      break;
    }

    case "ready": {
      if (sender.tab?.id) session.lastVideoTabId = sender.tab.id;
      if (message.state?.href) session.lastKnownVideoHref = message.state.href;
      session.lastContentState = message.state;

      const role = session.getRole();
      const isLeader = session.isLeader();

      const roomState = {
        type: "room-state",
        joined: !!session.room,
        role,
        peerId: session.peerId,
        lastLeaderState: session.lastLeaderState || null,
      };

      if (sender.tab?.id) {
        browser.tabs.sendMessage(sender.tab.id, roomState).catch(() => {});
      }

      if (session.room && message.state && (isLeader || session.room.policy === "both")) {
        const raw = encode({
          kind: "state",
          ts: Date.now(),
          room: session.room.code,
          from: session.peerId,
          policy: session.room.policy,
          leader: session.room.leaderId,
          state: message.state,
        });
        session.sendRaw(raw, true);
      } else if (session.room && role === "follower") {
        session.sendRaw(encode({
          kind: "sync-request",
          room: session.room.code,
          from: session.peerId,
          ts: Date.now(),
        }));
      }

      sendResponse(roomState);
      break;
    }

    case "emit": {
      const raw = encode({ ...message.msg, from: session.peerId, room: session.room?.code });
      if (session.room && session.client && session.clientConnected) {
        session.sendRaw(raw, !!message.msg?.state?.action);
      } else {
        session.pendingEmits.push(raw);
      }
      break;
    }

    case "create-room": {
      session.room = { code: makeRoomCode(), policy: message.policy || "leader", leaderId: session.peerId };
      session.shouldAutoOpenTab = false;
      session.activePeers.clear();
      session.lastLeaderState = null;
      if (sender.tab?.id) session.lastVideoTabId = sender.tab.id;

      if (!session.clientConnected) {
        relayUrl().then((url) => session.connect(url));
      } else {
        session.subscribeRoom(session.room.code);
      }
      broadcastRoomState(session);

      // Ask the active tab directly in this context for its live video state
      const isPriv = session.contextId === "private";
      browser.tabs.query({}).then(async (tabs) => {
        const matching = tabs.filter((t) => !t.incognito === isPriv);
        const activeTab = matching.find((t) => t.active) || matching[0];
        let state = null;
        if (activeTab?.id) {
          try {
            state = await browser.tabs.sendMessage(activeTab.id, { type: "get-state" });
          } catch {}
        }
        if (!state && activeTab?.url && activeTab.url.startsWith("http")) {
          state = {
            href: activeTab.url,
            playing: false,
            position: 0,
            action: true,
          };
        }
        if (state) {
          console.log(`[couchify:${session.contextId}] room created with video URL:`, state.href);
          session.lastContentState = state;
          session.lastKnownVideoHref = state.href;
          const raw = encode({
            kind: "state",
            ts: Date.now(),
            room: session.room.code,
            from: session.peerId,
            policy: session.room.policy,
            leader: session.room.leaderId,
            state,
          });
          session.sendRaw(raw, true);
        }
      }).catch(() => {});

      sendResponse({ ok: true, room: session.room.code, policy: session.room.policy });
      break;
    }

    case "join-room": {
      session.room = { code: message.code.toUpperCase(), policy: "leader", leaderId: null };
      session.shouldAutoOpenTab = true;
      session.activePeers.clear();
      session.lastLeaderState = null;
      session.lastKnownVideoHref = null;
      if (sender.tab?.id) session.lastVideoTabId = sender.tab.id;

      if (!session.clientConnected) {
        relayUrl().then((url) => session.connect(url));
      } else {
        session.subscribeRoom(session.room.code);
      }
      broadcastRoomState(session);
      sendResponse({ ok: true, room: session.room.code, policy: "both" });
      break;
    }

    case "leave-room": {
      session.leaveRoom();
      sendResponse({ ok: true });
      break;
    }

    case "status": {
      sendResponse({
        connected: session.clientConnected,
        room: session.room?.code || null,
        policy: session.room?.policy || null,
        peerCount: session.getPeerCount(),
      });
      break;
    }

    case "request-sync": {
      if (session.room && session.client && session.clientConnected) {
        session.sendRaw(encode({ kind: "sync-request", room: session.room.code, from: session.peerId, ts: Date.now() }));
      }
      sendResponse({ ok: true });
      break;
    }

    case "reconnect": {
      relayUrl().then((url) => {
        sessions.normal.connect(url);
        sessions.private.connect(url);
      });
      sendResponse({ ok: true });
      break;
    }
  }
  return true;
});
