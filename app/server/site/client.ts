import { FetchError } from "../../../src/adapters/types";
import { looksLikeChallenge } from "../../../src/utils/RequestQueue";
import { sleep as defaultSleep } from "../../../src/utils/async";

export interface SiteSettings {
  siteOrigin: string;
  cookie: string;
  userAgent: string;
  flaresolverrUrl: string;
  requestIntervalMs: number;
}

export interface Binary {
  body: Buffer;
  type: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A network failure in words: Node's fetch hides the reason (DNS, refused, timeout…) in `cause`. */
export function networkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "请求超时";
  const code = e?.cause?.code ?? "";
  const known: Record<string, string> = {
    ENOTFOUND: "域名解析失败（检查 NAS/容器的 DNS）",
    EAI_AGAIN: "域名解析失败（检查 NAS/容器的 DNS）",
    ECONNREFUSED: "连接被拒绝",
    ECONNRESET: "连接被重置（可能被网络拦截）",
    ETIMEDOUT: "连接超时",
    UND_ERR_CONNECT_TIMEOUT: "连接超时",
    UND_ERR_SOCKET: "连接中断",
    CERT_HAS_EXPIRED: "证书错误",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "证书错误",
  };
  const detail = e?.cause?.message ?? e?.message ?? String(err);
  return `${known[code] ?? "网络错误"}${code ? ` [${code}]` : ""}: ${detail}`;
}

/**
 * The site's reading ticket. Since November 2026 the site sends only the
 * start of each chapter page (followed by 「內容加載失敗！請刷新或更換瀏覽器」)
 * unless the request carries the cookie `jieqiSearchTicket`. Browsers get it
 * from the home and catalog pages, whose inline script loads
 * `/search.html?search_guard=css` (sets `jieqiSearchCss`) and `…=js` (sets
 * `jieqiSearchJs` from script, then requests `…=redeem`, which sets the
 * ticket). Each cookie lasts an hour (`Max-Age=3600`).
 */
const TICKET = "jieqiSearchTicket";
const GUARD_PATH = "/search.html?search_guard=";
/** Renew a little before the site's expiry. */
const TICKET_MARGIN_MS = 60_000;
/** After a failed attempt, pages stay as they came for a while instead of asking the site again each time. */
const TICKET_RETRY_MS = 10 * 60_000;

/** `name=value` of each Set-Cookie header, and the shortest Max-Age among them. */
function setCookies(res: Response, into: Record<string, string>): number | undefined {
  let maxAge: number | undefined;
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    into[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    for (const a of attrs) {
      const m = /^\s*max-age\s*=\s*(\d+)/i.exec(a);
      if (m) maxAge = Math.min(maxAge ?? Infinity, Number(m[1]));
    }
  }
  return maxAge;
}

/**
 * Reads what the guard script does without running it: the cookies it sets
 * (`document.cookie="name=value; …"`) and the URL it requests next.
 */
export function readGuardScript(js: string): { cookies: Record<string, string>; maxAge?: number; redeem?: string } {
  const cookies: Record<string, string> = {};
  let maxAge: number | undefined;
  for (const m of js.matchAll(/document\.cookie\s*=\s*"([^"]*)"/g)) {
    const [pair, ...attrs] = m[1].split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    for (const a of attrs) {
      const age = /^\s*max-age\s*=\s*(\d+)/i.exec(a);
      if (age) maxAge = Math.min(maxAge ?? Infinity, Number(age[1]));
    }
  }
  const open = /\.open\(\s*"GET"\s*,\s*"([^"]+)"/.exec(js)?.[1]?.replace(/\\\//g, "/");
  return { cookies, maxAge, redeem: open?.startsWith("/") ? open : undefined };
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * The server's HTTP access to the site: one request at a time with a minimum
 * gap (like the userscript), a phone browser's headers, and the cookie the
 * user pasted. A bot challenge is solved through FlareSolverr when one is
 * configured; its cookies and user agent are then reused.
 */
export class SiteClient {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;
  private imageTail: Promise<unknown> = Promise.resolve();
  private solved?: { cookies: Record<string, string>; userAgent: string };
  /** The reading ticket and its companion cookies, sent only to the origin that set them. */
  private ticket?: { origin: string; cookies: Record<string, string>; expires: number };
  private ticketPending?: Promise<void>;
  private ticketFailed?: { origin: string; at: number; error: FetchError };

  constructor(
    private readonly settings: () => SiteSettings,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forgets cookies obtained from FlareSolverr (e.g. after the settings changed). */
  reset(): void {
    this.solved = undefined;
    this.ticket = undefined;
    this.ticketFailed = undefined;
  }

  /** Whether requests to `origin` currently carry the site's reading ticket. */
  hasTicket(origin: string): boolean {
    return !!this.ticket && this.ticket.origin === origin && this.ticket.expires > this.now();
  }

  private headers(accept: string, referer?: string, url?: string, extra?: Record<string, string>): Record<string, string> {
    const s = this.settings();
    const cookies = new Map<string, string>();
    for (const part of s.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    for (const [k, v] of Object.entries(this.solved?.cookies ?? {})) cookies.set(k, v);
    // Like a browser, the ticket goes only to the origin that set it.
    const origin = url ? new URL(url).origin : undefined;
    if (origin && this.hasTicket(origin)) for (const [k, v] of Object.entries(this.ticket!.cookies)) cookies.set(k, v);
    for (const [k, v] of Object.entries(extra ?? {})) cookies.set(k, v);
    const headers: Record<string, string> = {
      "User-Agent": this.solved?.userAgent ?? s.userAgent,
      Accept: accept,
      "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
      Referer: referer ?? `${s.siteOrigin}/`,
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return headers;
  }

  /** Runs `task` in the site's serial lane, after the minimum gap. */
  private lane<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const wait = this.lastStart + this.settings().requestIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return task();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Fetches a page's HTML; throws FetchError (challenge = true when a bot check blocks it). */
  async html(url: string, retries = 2): Promise<string> {
    return (await this.document(url, retries)).html;
  }

  /** Like `html()`, also giving the URL the site answered from after redirects. */
  async document(url: string, retries = 2): Promise<{ html: string; url: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.lane(() => this.htmlOnce(url));
      } catch (err) {
        const e = err instanceof FetchError ? err : new FetchError(String(err), url);
        const retry = !e.challenge && (e.status === undefined || RETRYABLE.has(e.status));
        if (!retry || attempt >= retries) throw e;
        await this.sleep(3000 * 2 ** attempt);
      }
    }
  }

  private async htmlOnce(url: string): Promise<{ html: string; url: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", undefined, url),
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new FetchError(networkError(err), url);
    }
    const text = await res.text();
    if (looksLikeChallenge(text) || (res.status === 403 && /cloudflare/i.test(res.headers.get("server") ?? ""))) {
      if (this.settings().flaresolverrUrl) return { html: await this.solve(url), url };
      throw new FetchError("Bot challenge page returned", url, res.status, true);
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
    return { html: text, url: res.url || url };
  }

  /**
   * Gets the reading ticket for `origin` the way the site's home page does
   * (three small requests in the site's lane); concurrent callers share one
   * attempt. Throws FetchError when the site hands out no ticket.
   */
  fetchTicket(origin: string): Promise<void> {
    const failed = this.ticketFailed;
    if (failed && failed.origin === origin && this.now() - failed.at < TICKET_RETRY_MS) return Promise.reject(failed.error);
    if (!this.ticketPending) {
      this.ticketPending = this.redeemTicket(origin)
        .then(() => (this.ticketFailed = undefined))
        .catch((err: unknown) => {
          const error = err instanceof FetchError ? err : new FetchError(String(err), origin);
          this.ticketFailed = { origin, at: this.now(), error };
          throw error;
        })
        .finally(() => (this.ticketPending = undefined));
    }
    return this.ticketPending;
  }

  private async redeemTicket(origin: string): Promise<void> {
    const cookies: Record<string, string> = {};
    let maxAge = 3600;
    const get = (path: string, accept: string) =>
      this.lane(async () => {
        const url = `${origin}${path}`;
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            headers: this.headers(accept, `${origin}/`, url, cookies),
            redirect: "follow",
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new FetchError(networkError(err), url);
        }
        const text = await res.text();
        if (looksLikeChallenge(text)) throw new FetchError("Bot challenge page returned", url, res.status, true);
        if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
        maxAge = Math.min(maxAge, setCookies(res, cookies) ?? maxAge);
        return text;
      });
    await get(`${GUARD_PATH}css`, "text/css,*/*;q=0.1");
    const script = readGuardScript(await get(`${GUARD_PATH}js`, "*/*"));
    Object.assign(cookies, script.cookies);
    maxAge = Math.min(maxAge, script.maxAge ?? maxAge);
    await get(`${script.redeem ?? `${GUARD_PATH}redeem&r=`}${this.now()}`, "*/*");
    if (!cookies[TICKET]) throw new FetchError("网站没有发放阅读票据（jieqiSearchTicket）", `${origin}${GUARD_PATH}redeem`);
    this.ticket = { origin, cookies, expires: this.now() + maxAge * 1000 - TICKET_MARGIN_MS };
  }

  /** Loads the page through FlareSolverr and keeps the clearance cookies for later requests. */
  private async solve(url: string): Promise<string> {
    const endpoint = `${this.settings().flaresolverrUrl}/v1`;
    let data: {
      status?: string;
      message?: string;
      solution?: { status: number; response: string; userAgent: string; cookies: { name: string; value: string }[] };
    };
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000 }),
        signal: AbortSignal.timeout(90_000),
      });
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new FetchError(`FlareSolverr 无法连接：${networkError(err)}`, url, undefined, true);
    }
    const sol = data.solution;
    if (data.status !== "ok" || !sol) throw new FetchError(`FlareSolverr: ${data.message ?? "failed"}`, url, undefined, true);
    this.solved = {
      userAgent: sol.userAgent,
      cookies: Object.fromEntries(sol.cookies.map((c) => [c.name, c.value])),
    };
    if (looksLikeChallenge(sol.response)) throw new FetchError("Bot challenge not solved", url, sol.status, true);
    if (sol.status >= 400) throw new FetchError(`HTTP ${sol.status}`, url, sol.status);
    return sol.response;
  }

  /** One request to `url` without retries, for the settings page's connection test. */
  async probe(url: string): Promise<{ ok: boolean; ms: number; status?: number; challenge?: boolean; error?: string }> {
    const start = this.now();
    try {
      await this.html(url, 0);
      return { ok: true, ms: this.now() - start };
    } catch (err) {
      const e = err instanceof FetchError ? err : new FetchError(String(err), url);
      return { ok: false, ms: this.now() - start, status: e.status, challenge: e.challenge, error: e.message };
    }
  }

  /** Fetches an image or script (not rate limited like pages, but one at a time). */
  binary(url: string, referer?: string): Promise<Binary> {
    const run = this.imageTail.then(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: this.headers("image/avif,image/webp,image/*,*/*;q=0.8", referer, url),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new FetchError(networkError(err), url);
      }
      if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
      return {
        body: Buffer.from(await res.arrayBuffer()),
        type: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
      };
    });
    this.imageTail = run.catch(() => undefined);
    return run;
  }
}
