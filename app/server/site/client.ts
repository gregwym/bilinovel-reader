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

  private headers(accept: string, referer?: string): Record<string, string> {
    const s = this.settings();
    const cookies = new Map<string, string>();
    for (const part of s.cookie.split(";")) {
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

  private async htmlOnce(url: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new FetchError(`Network error: ${String(err)}`, url);
    }
    const text = await res.text();
    if (looksLikeChallenge(text) || (res.status === 403 && /cloudflare/i.test(res.headers.get("server") ?? ""))) {
      if (this.settings().flaresolverrUrl) return this.solve(url);
      throw new FetchError("Bot challenge page returned", url, res.status, true);
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
    return text;
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
      throw new FetchError(`FlareSolverr unavailable: ${String(err)}`, url, undefined, true);
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
        throw new FetchError(`Network error: ${String(err)}`, url);
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
