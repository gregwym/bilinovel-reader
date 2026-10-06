/**
 * Cross-origin HTTP for third-party APIs (e.g. Azure TTS).
 *
 * Uses the userscript manager's GM.xmlHttpRequest when granted, which is not
 * subject to the page's CORS/CSP; falls back to window.fetch otherwise
 * (development builds, managers without the grant).
 */

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface GmXhrResponse {
  status: number;
  responseHeaders: string;
  response: ArrayBuffer;
}

interface GmXhrDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  responseType: "arraybuffer";
  timeout?: number;
  onload: (r: GmXhrResponse) => void;
  onerror: (e: unknown) => void;
  ontimeout: (e: unknown) => void;
}

type GmXhr = (details: GmXhrDetails) => unknown;

function gmXhr(): GmXhr | undefined {
  const g = globalThis as unknown as {
    GM?: { xmlHttpRequest?: GmXhr };
    GM_xmlhttpRequest?: GmXhr;
  };
  if (typeof g.GM?.xmlHttpRequest === "function") return g.GM.xmlHttpRequest.bind(g.GM);
  if (typeof g.GM_xmlhttpRequest === "function") return g.GM_xmlhttpRequest;
  return undefined;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const xhr = gmXhr();
  if (xhr) {
    return new Promise((resolve, reject) => {
      xhr({
        method: req.method,
        url: req.url,
        headers: req.headers,
        data: req.body,
        responseType: "arraybuffer",
        timeout: req.timeoutMs,
        onload: (r) =>
          resolve({ status: r.status, headers: parseHeaders(r.responseHeaders ?? ""), body: r.response }),
        onerror: () => reject(new NetworkError("Network request failed")),
        ontimeout: () => reject(new NetworkError("Network request timed out")),
      });
    });
  }
  const controller = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined;
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
      credentials: "omit",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.arrayBuffer() };
  } catch (err) {
    throw new NetworkError(String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function bodyText(res: HttpResponse): string {
  try {
    return new TextDecoder().decode(res.body);
  } catch {
    return "";
  }
}
