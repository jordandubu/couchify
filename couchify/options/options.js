const input = document.getElementById("relayUrl");
const saved = document.getElementById("saved");

(async () => {
  let val;
  try {
    const loc = await browser.storage.local.get({ relayUrl: null });
    val = loc?.relayUrl;
  } catch {}
  if (!val) {
    try {
      const syn = await browser.storage.sync.get({ relayUrl: null });
      val = syn?.relayUrl;
    } catch {}
  }
  if (val) input.value = val;
})();

document.getElementById("save").addEventListener("click", async () => {
  const val = input.value.trim();
  if (val) {
    try { await browser.storage.local.set({ relayUrl: val }); } catch {}
    try { await browser.storage.sync.set({ relayUrl: val }); } catch {}
  } else {
    try { await browser.storage.local.remove("relayUrl"); } catch {}
    try { await browser.storage.sync.remove("relayUrl"); } catch {}
  }
  // Tell background worker to reconnect immediately with the new URL
  try { await browser.runtime.sendMessage({ type: "reconnect" }); } catch {}
  saved.classList.add("show");
  setTimeout(() => { saved.classList.remove("show"); }, 1500);
});