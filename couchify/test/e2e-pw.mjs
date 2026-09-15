// Couchify E2E via Playwright: two headed-ish Chromium contexts (persistent),
// each with the unpacked extension. Room ops go through the popup page (same
// path as real users). Proves: create room in A → join in B → A acts → B's
// video follows; then B acts → A follows.
// Usage: node e2e-pw.mjs   (relay on ws://localhost:8080, page server on :8788)
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PAGE = "file:///tmp/couchify-test/index.html";

const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "couchify-pw-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });
  await sleep(2500);
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(PAGE);
  await page.waitForSelector("video");
  // popup page for runtime messages (same as clicking the real popup)
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(500);
  return { ctx, sw, page, popup };
}

const popupSend = (popup, msg) => popup.evaluate((m) => new Promise((res) =>
  chrome.runtime.sendMessage(m, (x) => res(chrome.runtime.lastError ? { err: chrome.runtime.lastError.message } : x))), msg);

async function main() {
  const a = await launch();
  const b = await launch();

  // 1) use default cloud broker

  // 2) create room in A, join in B (via popup pages)
  const room = await popupSend(a.popup, { type: "create-room", policy: "both" });
  if (!room.room) throw new Error("create-room failed: " + JSON.stringify(room));
  await sleep(1000);
  const joined = await popupSend(b.popup, { type: "join-room", code: room.room });
  if (joined.err) throw new Error("join failed: " + JSON.stringify(joined));
  await sleep(1500);

  const bTime = () => b.page.evaluate("document.getElementById('v').currentTime");
  const bPaused = () => b.page.evaluate("document.getElementById('v').paused");
  const aTime = () => a.page.evaluate("document.getElementById('v').currentTime");

  // 3) A: play → pause+seek to 8 → B follows
  await a.page.evaluate("document.getElementById('v').play()");
  await sleep(800);
  await a.page.evaluate("const v = document.getElementById('v'); v.pause(); v.currentTime = 8");
  await sleep(2000);
  const t1 = await bTime(), p1 = await bPaused();
  check("A pause+seek8 → B follows", Math.abs(t1 - 8) < 1.5 && p1 === true, `(B t=${t1.toFixed(2)} paused=${p1})`);

  // 4) B: pause+seek to 3 → A follows (policy both)
  await b.page.evaluate("const v = document.getElementById('v'); v.pause(); v.currentTime = 3");
  await sleep(2000);
  const t2 = await aTime();
  check("B seek3 → A follows", Math.abs(t2 - 3) < 1.5, `(A t=${t2.toFixed(2)})`);

  console.log(results.join("\n"));
  const fail = results.some((r) => r.startsWith("FAIL"));
  await a.ctx.close();
  await b.ctx.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });