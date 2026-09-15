
// Couchify shared protocol: message schema, constants, encode/decode.
// Loaded by content script and background worker via manifest.

export const PROTOCOL_VERSION = 1;
// Free public relay. Configurable via options; see relay/README.md for the
// ~120-line Node fallback if this endpoint ever disappears.
export const DEFAULT_RELAY_URL = "wss://broker.hivemq.com:8884/mqtt";
// Local dev: run relay/ (npm start) and set Relay URL in options to
// ws://localhost:8080 — storage.sync overrides DEFAULT_RELAY_URL.
export const DRIFT_THRESHOLD_SEC = 1.5;
export const TIMEUPDATE_EMIT_MS = 2000;
export const ROOM_CODE_LEN = 6;

/** Generate a 6-char alphanumeric room code (unambiguous charset). */
export function makeRoomCode(len = ROOM_CODE_LEN) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const rand = crypto.getRandomValues(new Uint32Array(len));
  for (let i = 0; i < len; i++) s += alphabet[rand[i] % alphabet.length];
  return s;
}

/** Generate a stable per-install peer id. */
export function makePeerId() {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return "p" + Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{kind:"state"|"sync-request", room:string, from:string, ts:number,
 *          state?:{playing:boolean, position:number, rate:number, href:string,
 *                  title:string, region:{cc:string, lang:string, tz:string}}}} msg
 */
export function encode(msg) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}

/** @returns {object|null} parsed message or null if invalid/foreign version */
export function decode(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== PROTOCOL_VERSION) return null;
    if (obj.kind !== "state" && obj.kind !== "sync-request" && obj.kind !== "buffer") return null;
    if (typeof obj.room !== "string" || typeof obj.from !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}