// Couchify content script: binds the site's <video>, emits state, applies
// remote state cleanly without audio distortion or feedback loops,
// displays subtle in-video toasts, and handles buffer coordination.

import { decode, encode } from "../lib/protocol.js";
import { detectRegion, detectTitle } from "../lib/region.js";
import "../lib/compat.js";

let video = null;
let applyingRemote = false;   // suppress echoing our own applied change
let applyTimeout = null;
let role = "both";            // "both" | "leader" | "follower"
let joined = false;
let lastPeerState = null;     // latest state from a peer
let pendingRemoteState = null;// buffered state if message arrives before video binds
let lastEmitAt = 0;
let lastDriftCheckAt = 0;
let selfPeerId = null;
let lastKnownHref = location.href;
let toastTimeout = null;
let isBuffering = false;
let bufferTimeout = null;

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

function bindVideo() {
  const candidates = Array.from(document.querySelectorAll("video"));
  if (!candidates.length) return false;
  // Largest video wins
  candidates.sort((a, b) =>
    (b.videoWidth * b.videoHeight || b.clientWidth * b.clientHeight) -
    (a.videoWidth * a.videoHeight || a.clientWidth * a.clientHeight));
  if (video && candidates[0] === video) return true;
  video = candidates[0];
  video.playbackRate = 1.0;
  for (const ev of ["play", "pause", "seeked", "ratechange"]) {
    video.addEventListener(ev, onLocalEvent);
  }
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("waiting", onVideoWaiting);
  video.addEventListener("playing", onVideoPlaying);
  return true;
}

function onVideoWaiting() {
  if (!joined || !video || video.paused) return;
  if (bufferTimeout) clearTimeout(bufferTimeout);
  bufferTimeout = setTimeout(() => {
    if (!video.paused) {
      isBuffering = true;
      browser.runtime.sendMessage({
        type: "emit",
        immediate: true,
        msg: { kind: "buffer", buffering: true, ts: Date.now() },
      }).catch(() => {});
    }
  }, 500);
}

function onVideoPlaying() {
  if (bufferTimeout) clearTimeout(bufferTimeout);
  if (isBuffering) {
    isBuffering = false;
    browser.runtime.sendMessage({
      type: "emit",
      immediate: true,
      msg: { kind: "buffer", buffering: false, ts: Date.now() },
    }).catch(() => {});
  }
}

function currentState(action = false) {
  if (!video) return null;
  return {
    playing: !video.paused,
    position: video.currentTime,
    rate: video.playbackRate || 1.0,
    href: location.href,
    title: detectTitle(),
    region: detectRegion(),
    action, // true = user-visible action (play/pause/seek); false = beacon
  };
}

function onLocalEvent(e) {
  if (applyingRemote) return;

  if (role === "follower") {
    // If the room is in Leader-only mode, followers cannot override the leader!
    if (lastPeerState) {
      if (!lastPeerState.playing && !video.paused) {
        // Leader is paused, but follower pressed play: snap back to pause!
        applySafely(() => {
          video.pause();
        });
        showSyncToast("👑", "Paused by leader (leader control only)");
        return;
      }
      if (lastPeerState.playing && video.paused) {
        // Leader is playing, but follower paused: snap back to play!
        applySafely(() => {
          video.play().catch(() => showAutoplayOverlay());
        });
        showSyncToast("👑", "Playback locked to leader");
        return;
      }
      if (e && e.type === "seeked") {
        // Follower sought: snap back to leader's position!
        const timePassed = (Date.now() - (lastPeerState.ts || lastPeerState.receivedAt)) / 1000;
        const expected = lastPeerState.position + (lastPeerState.playing ? timePassed * (lastPeerState.rate || 1.0) : 0);
        if (Math.abs(video.currentTime - expected) > 1.5) {
          applySafely(() => {
            video.currentTime = expected;
          });
          showSyncToast("👑", "Seeking locked to leader");
          return;
        }
      }
    } else {
      browser.runtime.sendMessage({ type: "request-sync" }).catch(() => {});
    }
    return;
  }

  emit(true, true);
}

function onTimeUpdate() {
  if (!video || !lastPeerState) return;

  // If leader is paused, follower MUST remain paused!
  if (!lastPeerState.playing && !video.paused && role === "follower") {
    applySafely(() => {
      video.pause();
    });
    return;
  }

  const now = Date.now();

  // Drift check throttled to once every 4 seconds, and only if drift is significant (>2.5s)
  if (now - lastDriftCheckAt >= 4000) {
    lastDriftCheckAt = now;
    if (lastPeerState.playing && !video.paused) {
      const timePassed = (now - lastPeerState.receivedAt) / 1000;
      const expected = lastPeerState.position + timePassed * (lastPeerState.rate || 1.0);
      const drift = Math.abs(video.currentTime - expected);

      if (drift > 2.5) {
        console.log(`[couchify] correcting drift (${drift.toFixed(1)}s): seeking to ${expected.toFixed(1)}s`);
        applySafely(() => {
          video.currentTime = expected;
        });
      }
    }
  }

  // Periodic slow beacon (every 4s)
  if (now - lastEmitAt >= 4000 && role !== "follower") {
    emit(false, false);
  }
}

function emit(immediate, action = false) {
  if (!video || !joined) return;
  const state = currentState(action);
  if (!state) return;
  lastEmitAt = Date.now();
  browser.runtime.sendMessage({
    type: "emit",
    immediate,
    msg: { kind: "state", ts: Date.now(), state },
  }).catch(() => {});
}

function applySafely(fn) {
  applyingRemote = true;
  if (applyTimeout) clearTimeout(applyTimeout);
  try { fn(); } catch (e) { console.warn("[couchify] apply error:", e); }
  applyTimeout = setTimeout(() => {
    applyingRemote = false;
    applyTimeout = null;
  }, 250);
}

function showSyncToast(title, text) {
  let toast = document.getElementById("couchify-sync-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "couchify-sync-toast";
    toast.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 99999999;
      background: #09090b; color: #fafafa;
      border: 1px solid #27272a; border-radius: 6px;
      padding: 7px 13px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      opacity: 0; transform: translateY(-6px);
    `;
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#34d399"></span><span>${title ? title + ": " : ""}${text}</span>`;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, 2200);
}

function applyRemote(msg) {
  if (!msg || msg.from === selfPeerId) return;

  // Handle friend buffering
  if (msg.kind === "buffer") {
    if (msg.buffering) {
      showSyncToast("Buffering", "Pausing for peer…");
      applySafely(() => { if (video) video.pause(); });
    } else {
      showSyncToast("Buffering", "Resuming playback");
      applySafely(() => { if (video) video.play().catch(() => {}); });
    }
    return;
  }

  // Follow host if navigated to a different video
  if (msg.state?.href && !isSameVideo(location.href, msg.state.href)) {
    console.log("[couchify] host changed video, following to:", msg.state.href);
    showSyncToast("Host changed video", "Switching video…");
    location.href = msg.state.href;
    return;
  }

  if (!video) {
    if (msg.state) {
      console.log("[couchify] buffering remote state for when video loads:", msg.state);
      pendingRemoteState = { ...msg.state, receivedAt: Date.now() };
    }
    return;
  }

  if (msg.state) {
    doApplyState(msg.state);
  }
}

function doApplyState(remoteState) {
  if (!video || !remoteState) return;
  lastPeerState = { ...remoteState, receivedAt: Date.now() };

  const timePassed = (Date.now() - (remoteState.ts || lastPeerState.receivedAt)) / 1000;
  const expectedPosition = remoteState.position + (remoteState.playing ? timePassed * (remoteState.rate || 1.0) : 0);

  applySafely(() => {
    // Only seek if difference is more than 1.2s to prevent micro-jumps
    if (Math.abs(video.currentTime - expectedPosition) > 1.2) {
      video.currentTime = expectedPosition;
    }

    // Play/pause sync with in-video toast notification
    if (remoteState.playing && video.paused) {
      showSyncToast("Sync", "Playing");
      video.play().catch(() => showAutoplayOverlay());
    } else if (!remoteState.playing && !video.paused) {
      showSyncToast("Sync", "Paused");
      video.pause();
    }
  });
}

function showAutoplayOverlay() {
  if (document.getElementById("couchify-play-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "couchify-play-overlay";
  overlay.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 99999999;
    background: #09090b; color: #fafafa; border: 1px solid #3f3f46;
    border-radius: 6px; padding: 9px 15px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px; font-weight: 500; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6); display: flex; align-items: center; gap: 8px;
  `;
  overlay.innerHTML = `<span style="color:#34d399">▶</span> Click to resume synced playback`;
  const resume = () => {
    if (video) video.play().catch(() => {});
    overlay.remove();
  };
  overlay.onclick = resume;
  document.addEventListener("click", resume, { once: true });
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 8000);
}

function handleMessage(message, sender, sendResponse) {
  if (message.type === "get-state") {
    const s = currentState(true);
    if (sendResponse) sendResponse(s);
    return true;
  }
  if (message.type === "peer-msg") applyRemote(decode(message.raw));
  if (message.type === "peer-id") selfPeerId = message.peerId;
  if (message.type === "sync-request") emit(true, true);
  if (message.type === "room-state") {
    joined = message.joined;
    role = message.role;
    if (message.peerId) selfPeerId = message.peerId;
    if (message.lastLeaderState && role === "follower") {
      if (video) doApplyState(message.lastLeaderState);
      else pendingRemoteState = message.lastLeaderState;
    }
    if (joined && video && role !== "follower") emit(true, true);
  }
}
browser.runtime.onMessage.addListener(handleMessage);

function emitNewVideo(href) {
  if (!joined || role === "follower") return;
  const startPos = getUrlTimestamp(href);
  const state = {
    href,
    title: detectTitle(),
    region: detectRegion(),
    playing: true,
    position: startPos,
    rate: 1.0,
    action: true,
  };
  browser.runtime.sendMessage({
    type: "emit",
    immediate: true,
    msg: { kind: "state", ts: Date.now(), state },
  }).catch(() => {});
}

// Handle Single-Page App navigations
function onUrlChange() {
  if (!isSameVideo(lastKnownHref, location.href)) {
    console.log("[couchify] video URL changed to:", location.href);
    lastKnownHref = location.href;
    if (joined && role !== "follower") {
      emitNewVideo(location.href);
    }
    setTimeout(bindVideo, 400);
    setTimeout(() => {
      bindVideo();
      if (joined && role !== "follower") emit(true, true);
    }, 1200);
  }
}
window.addEventListener("yt-navigate-finish", onUrlChange);
window.addEventListener("popstate", onUrlChange);
window.addEventListener("hashchange", onUrlChange);
setInterval(onUrlChange, 1000);

// Fetch initial room state immediately on script inject
async function initRoomState() {
  try {
    const res = await browser.runtime.sendMessage({ type: "get-room-state" });
    if (res) {
      joined = !!res.joined;
      role = res.role || "both";
      selfPeerId = res.peerId || null;
      if (res.lastLeaderState) {
        pendingRemoteState = res.lastLeaderState;
        if (video) doApplyState(res.lastLeaderState);
      }
    }
  } catch {}
}
initRoomState();

// Join flow: bind video and sync
function tryBind() {
  if (bindVideo()) {
    browser.runtime.sendMessage({ type: "ready", state: currentState() }).then((res) => {
      if (res) {
        joined = !!res.joined;
        role = res.role || "both";
        selfPeerId = res.peerId || null;
        if (res.lastLeaderState && role === "follower") {
          doApplyState(res.lastLeaderState);
        }
      }
    }).catch(() => {});

    if (pendingRemoteState) {
      console.log("[couchify] applying buffered initial state on video bind");
      doApplyState(pendingRemoteState);
      pendingRemoteState = null;
    }
    browser.runtime.sendMessage({ type: "request-sync" }).catch(() => {});
  } else {
    setTimeout(tryBind, 500);
  }
}
tryBind();