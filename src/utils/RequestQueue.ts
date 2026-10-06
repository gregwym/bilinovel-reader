import { FetchError } from "../adapters/types";
import { log } from "./log";
import { sleep as defaultSleep } from "./async";

export interface RequestQueueOptions {
  /** Minimum gap between the start of two network requests. */
  minIntervalMs?: number;
  /** Retries after the first attempt for temporary failures. */
  maxRetries?: number;
  /** Base for exponential backoff (doubles per retry). */
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** Heuristics for bot-challenge pages (Cloudflare and the site's own "load failed" page). */
export function looksLikeChallenge(html: string): boolean {
  return (
    /<title>\s*(Just a moment|Attention Required|請稍候|请稍候)/i.test(html) ||
    html.includes("cf-chl-") ||
    html.includes("challenge-platform") ||
    /Access denied \| [^<]* used Cloudflare/i.test(html)
  );
}

/**
 * Serial, rate-limited HTML fetcher. Concurrency is always 1: every request
 * waits for the previous one to finish and for `minIntervalMs` to elapse.
 * Identical in-flight URLs are de-duplicated.
 */
export class RequestQueue {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(options: RequestQueueOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 4000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 4000;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Fetches `url` as text. Rejects with FetchError after retries are exhausted. */
  fetchText(url: string, init: RequestInit = {}): Promise<string> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const run = this.tail.then(() => this.runWithRetry(url, init));
    this.tail = run.catch(() => undefined);
    this.inflight.set(url, run);
    const cleanup = () => this.inflight.delete(url);
    run.then(cleanup, cleanup);
    return run;
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.lastStart + this.minIntervalMs - this.now();
    if (wait > 0) {
      log.debug(`rate limit: waiting ${wait}ms`);
      await this.sleep(wait);
    }
    this.lastStart = this.now();
  }

  private async runWithRetry(url: string, init: RequestInit): Promise<string> {
    let attempt = 0;
    for (;;) {
      await this.waitForSlot();
      try {
        return await this.attempt(url, init);
      } catch (err) {
        const retryable = err instanceof FetchError ? isRetryable(err) : true;
        if (!retryable || attempt >= this.maxRetries) {
          throw err instanceof FetchError ? err : new FetchError(String(err), url);
        }
        const delay = this.backoffBaseMs * 2 ** attempt;
        attempt++;
        log.warn(`fetch failed (${String(err)}); retry ${attempt}/${this.maxRetries} in ${delay}ms`, url);
        await this.sleep(delay);
      }
    }
  }

  private async attempt(url: string, init: RequestInit): Promise<string> {
    log.debug("GET", url);
    const res = await this.fetchImpl(url, { credentials: "include", ...init });
    const text = await res.text();
    if (looksLikeChallenge(text)) {
      throw new FetchError("Bot challenge page returned", url, res.status, true);
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, url, res.status);
    return text;
  }
}

function isRetryable(err: FetchError): boolean {
  if (err.challenge) return false;
  if (err.status === undefined) return true; // network error
  return RETRYABLE_STATUS.has(err.status);
}
