/**
 * The site's `night` cookie.
 *
 * The site sends a chapter page whole only with the cookie `night`, which its
 * `/scripts/darkmode.js` sets on the first page a browser shows (the light or
 * dark theme; a session cookie, gone when the browser session ends). Without
 * it the page holds only the first paragraphs, the last one cut off by
 * 「內容加載失敗！請刷新或更換瀏覽器」: what a browser shows on the first page
 * after the cookie lapsed, until it reloads. Checked on 2026-11-04 (book 5370,
 * chapter 288458): only `night` made the difference; the value does not matter.
 *
 * Reader requests carry it the way a browser that has shown one site page does:
 * the userscript sets it in the browser when it is missing, the server sends
 * it with every page request.
 */

export const NIGHT_COOKIE = "night";

/** The value darkmode.js picks when it first sets the cookie: dark after 19:59 and before 06:00. */
export function nightValue(now: Date = new Date()): "0" | "1" {
  const hour = now.getHours();
  return hour > 19 || hour < 6 ? "1" : "0";
}

/** Does a `Cookie` header (or `document.cookie`) carry the cookie? */
export function hasNightCookie(cookies: string): boolean {
  return cookies.split(";").some((part) => part.split("=")[0].trim() === NIGHT_COOKIE);
}

/** `cookies` (a Cookie header) with `night` added, unless it is already there. */
export function withNightCookie(cookies: string, value: "0" | "1" = "0"): string {
  if (hasNightCookie(cookies)) return cookies;
  return [cookies.trim(), `${NIGHT_COOKIE}=${value}`].filter(Boolean).join("; ");
}

/**
 * In the browser: sets the cookie the way darkmode.js would when it is missing
 * (never changes the reader's own choice). Returns whether it set it.
 */
export function ensureNightCookie(doc: Document = document, now?: Date): boolean {
  if (hasNightCookie(doc.cookie)) return false;
  doc.cookie = `${NIGHT_COOKIE}=${nightValue(now)};path=/`;
  return hasNightCookie(doc.cookie);
}
