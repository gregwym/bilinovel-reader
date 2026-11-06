import { FetchError } from "../../../src/adapters/types";
import { looksLikeChallenge } from "../../../src/utils/RequestQueue";
import { sleep as defaultSleep } from "../../../src/utils/async";
import { NIGHT_COOKIE, withNightCookie } from "../../../src/adapters/bilinovel/siteCookies";
import { SUPPORTED_HOSTS } from "../../../src/adapters/bilinovel/url";

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

/** Redirects followed for one page (the site sends one: www.bilinovel.com → www.bilinovel.net). */
const MAX_REDIRECTS = 5;

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * The server's HTTP access to the site: one request at a time with a minimum
 * gap (like the userscript), a phone browser's headers, and the cookie the
 * user pasted. A bot challenge is solved through FlareSolverr when one is
 * configured; its cookies and user agent are then reused.
 */
export class SiteClient {
  private readonly queue: { url: string; start: () => Promise<void> }[] = [];
  private busy = false;
  private lastStart = -Infinity;
  /** Pages asked for by background work (see `html`), until someone waits for them. */
  private readonly background = new Set<string>();
  private imageTail: Promise<unknown> = Promise.resolve();
  private solved?: { cookies: Record<string, string>; userAgent: string };

  constructor(
    private readonly settings: () => SiteSettings,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forgets cookies obtained from FlareSolverr (e.g. after the settings changed). */
  reset(): void {
    this.solved = undefined;
  }

  private headers(accept: string, referer?: string, url?: string): Record<string, string> {
    const s = this.settings();
    const cookies = new Map<string, string>();
    // The site's own cookie a browser has after one page (see siteCookies.ts); the user's cookie wins.
    for (const part of withNightCookie(s.cookie).split(";")) {
      const i = part.indexOf("=");
      if (i > 0) cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    for (const [k, v] of Object.entries(this.solved?.cookies ?? {})) cookies.set(k, v);
    const headers: Record<string, string> = {
      "User-Agent": this.solved?.userAgent ?? s.userAgent,
      Accept: accept,
      "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
      Referer: referer ?? `${s.siteOrigin}/`,
    };
    // Cookies go to the site's own hosts only (a redirect could lead elsewhere).
    const site = !url || SUPPORTED_HOSTS.includes(new URL(url).hostname) || new URL(url).origin === new URL(s.siteOrigin).origin;
    if (cookies.size && site) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return headers;
  }

  /**
   * Runs `task` in the site's serial lane, after the minimum gap. What a
   * person waits for (the reader, a catalog refresh) goes before background
   * work, which only gets the turns nobody else wants.
   */
  private lane<T>(url: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ url, start: () => task().then(resolve, reject) });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    try {
      const wait = this.lastStart + this.settings().requestIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      // Chosen after the gap: a request that came meanwhile still goes first.
      let i = this.queue.findIndex((e) => !this.background.has(e.url));
      if (i < 0) i = 0;
      const [entry] = this.queue.splice(i, 1);
      this.lastStart = this.now();
      await entry.start();
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  /** A page asked for in the background is now waited for: it takes its turn like any other. */
  promote(url: string): void {
    this.background.delete(url);
  }

  /**
   * Fetches a page's HTML; throws FetchError (challenge = true when a bot
   * check blocks it). `background`: after everything a person waits for.
   */
  async html(url: string, retries = 2, background = false): Promise<string> {
    if (background) this.background.add(url);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.lane(url, () => this.htmlOnce(url));
        } catch (err) {
          const e = err instanceof FetchError ? err : new FetchError(String(err), url);
          const retry = !e.challenge && (e.status === undefined || RETRYABLE.has(e.status));
          if (!retry || attempt >= retries) throw e;
          await this.sleep(3000 * 2 ** attempt);
        }
      }
    } finally {
      if (background) this.background.delete(url);
    }
  }

  private async htmlOnce(url: string): Promise<string> {
    let res: Response;
    try {
      res = await this.follow(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    } catch (err) {
      throw new FetchError(networkError(err), url);
    }
    const text = await res.text();
    if (looksLikeChallenge(text) || (res.status === 403 && /cloudflare/i.test(res.headers.get("server") ?? ""))) {
      if (this.settings().flaresolverrUrl) return this.solve(url);
      throw new FetchError("Bot challenge page returned", url, res.status, true);
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
    return text;
  }

  /**
   * Follows redirects itself: fetch drops the Cookie header when a redirect
   * changes the origin (www.bilinovel.com → www.bilinovel.net), and the page
   * then comes without its `night` cookie (and the user's), cut short.
   */
  private async follow(url: string, accept: string): Promise<Response> {
    let current = url;
    for (let hops = 0; ; hops++) {
      const res = await this.fetchImpl(current, {
        headers: this.headers(accept, undefined, current),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location || hops >= MAX_REDIRECTS) return res;
      await res.body?.cancel();
      current = new URL(location, current).href;
    }
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
        // Its browser starts afresh each time: give it the site's `night` cookie too.
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000, cookies: [{ name: NIGHT_COOKIE, value: "0" }] }),
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
          headers: this.headers("image/avif,image/webp,image/*,*/*;q=0.8", referer),
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
