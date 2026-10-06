const DEBUG_KEY = "biliReader.debug";

function debugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

const PREFIX = "[BiliReader]";

export const log = {
  debug(...args: unknown[]): void {
    if (debugEnabled()) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
