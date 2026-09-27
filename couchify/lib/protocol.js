
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

// --- Room payload encryption -------------------------------------------------
// The public broker sees topic names (couchify/v1/room/<code>) but room
// payloads are AES-GCM encrypted with a key derived from the room code. Anyone
// wildcard-subscribing to the broker reads only opaque ciphertext; knowing a
// room code is exactly the "know the room" credential, so a code-derived key
// adds no key-distribution problem. Fixed "pepper" binds ciphertext to this app.
const ENC_PEPPER = "couchify/v1";
const roomKeyCache = new Map(); // code -> Promise<CryptoKey>

function roomKey(code) {
  let p = roomKeyCache.get(code);
  if (!p) {
    const enc = new TextEncoder();
    p = crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode(ENC_PEPPER), iterations: 100_000, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
    roomKeyCache.set(code, p);
  }
  return p;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Encrypt a plaintext (encoded) protocol message for a room. Resolves to the wire string. */
export async function encryptRoomPayload(code, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await roomKey(code),
    new TextEncoder().encode(plaintext),
  );
  return JSON.stringify({ v: PROTOCOL_VERSION, e: 1, iv: b64(iv), d: b64(ct) });
}

/** Decrypt a wire string for a room. Resolves to the message object, or null. */
export async function decryptRoomPayload(code, wire) {
  try {
    const env = JSON.parse(wire);
    if (!env || env.e !== 1 || typeof env.iv !== "string" || typeof env.d !== "string") return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(env.iv) },
      await roomKey(code),
      unb64(env.d),
    );
    return decode(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}