/** Calls to the library server. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("无法连接服务器", 0, "network");
  }
  if (res.status === 401 && !path.startsWith("/api/login")) {
    const back = location.pathname + location.search;
    if (!location.pathname.startsWith("/login")) location.href = `/login?next=${encodeURIComponent(back)}`;
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    // Not from the app (no JSON): a reverse proxy in front of it timed out or can't reach it.
    const gateway = res.status === 502 || res.status === 504 ? "：反向代理未收到书库服务的响应（服务未运行，或请求超时）" : "";
    throw new ApiError(data.error ?? `HTTP ${res.status}${gateway}`, res.status, data.code);
  }
  return data;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};
