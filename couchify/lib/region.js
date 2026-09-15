// Region/locale/title extraction per supported site + generic fallback.
// Advisory only: popups compare peer regions; sync never blocks on mismatch.

/**
 * @returns {{cc:string, lang:string, tz:string}}
 *   cc: site-level country (may be ""), lang: page language, tz: IANA timezone.
 */
export function detectRegion() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const lang = navigator.language || "";
  return { cc: detectCountryCode(), lang, tz };
}

function detectCountryCode() {
  const host = location.hostname;
  // Netflix: /<cc>/title/... or /watch/<id>?locale=...; country in URL path for some locales.
  if (host.endsWith("netflix.com")) {
    const m = location.pathname.match(/^\/([a-z]{2})(?:$|\/)/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search);
    return q.get("geo") || q.get("locale")?.split("-")[1] || "";
  }
  // Max: play.max.com/<cc>/
  if (host.endsWith("max.com") || host.endsWith("play.max.com")) {
    const m = location.pathname.match(/^\/([a-z]{2})(?:$|\/)/);
    return m ? m[1] : "";
  }
  // YouTube: ?gl=CC or hl in URL; also html lang attr.
  if (host.endsWith("youtube.com")) {
    const q = new URLSearchParams(location.search);
    const gl = q.get("gl");
    if (gl) return gl.toLowerCase();
    const m = (document.documentElement.getAttribute("lang") || "").split("-")[1];
    return m ? m.toLowerCase() : "";
  }
  return "";
}

/**
 * Player title text for catalog-mismatch comparison.
 * @returns {string}
 */
export function detectTitle() {
  const host = location.hostname;
  if (host.endsWith("netflix.com")) {
    return document.querySelector("[data-uia='video-title'] h1")?.textContent?.trim()
      || document.title.replace(" | Netflix", "").trim();
  }
  if (host.endsWith("max.com")) {
    return document.querySelector("h1")?.textContent?.trim() || document.title;
  }
  if (host.endsWith("youtube.com")) {
    return document.querySelector("h1.ytd-watch-metadata, h1.title")?.textContent?.trim()
      || document.title;
  }
  return document.querySelector("h1")?.textContent?.trim() || document.title;
}