/**
 * Loads a same-origin page in an iframe so it goes through a normal document
 * navigation: Cloudflare's JavaScript challenge can complete there (it often
 * blocks script `fetch` requests but lets navigations through), and the
 * site's own scripts run, so the rendered DOM is already de-obfuscated.
 *
 * If a challenge needs the user (e.g. a checkbox), the frame is revealed via
 * the FrameHost so it can be solved without leaving the reader.
 */

import { looksLikeChallenge } from "../../utils/RequestQueue";
import { log } from "../../utils/log";
import { FetchError, type FrameHost } from "../types";

export type { FrameHost };

export interface LoadedFrame {
  doc: Document;
  win: Window;
  dispose(): void;
}

export interface FrameLoadOptions {
  /** Wait for an automatic challenge before showing it to the user. */
  revealAfterMs?: number;
  /** Give up after this long (including time spent waiting for the user). */
  timeoutMs?: number;
  /** Is the loaded document the page we want (vs. a challenge/interstitial)? */
  isReady: (doc: Document) => boolean;
}

/** Default host: a fixed, invisible iframe in the page; revealed full-screen when needed. */
export const defaultFrameHost: FrameHost = {
  attach(iframe) {
    iframe.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;opacity:0;pointer-events:none;z-index:-1;";
    document.documentElement.append(iframe);
  },
  reveal(iframe) {
    iframe.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;background:#fff;z-index:2147483647;";
  },
  detach(iframe) {
    iframe.remove();
  },
};

export function loadInFrame(url: string, host: FrameHost, options: FrameLoadOptions): Promise<LoadedFrame> {
  const revealAfterMs = options.revealAfterMs ?? 8000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    // No popups / top navigation from the site's scripts; scripts and forms are needed for the challenge.
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Bili Reader loader";
    const start = Date.now();
    let revealed = false;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      if (err) {
        host.detach(iframe);
        reject(err);
        return;
      }
      const doc = iframe.contentDocument!;
      const win = iframe.contentWindow!;
      resolve({ doc, win, dispose: () => host.detach(iframe) });
    };

    const check = () => {
      let doc: Document | null;
      try {
        doc = iframe.contentDocument;
      } catch {
        return finish(new FetchError("Frame became cross-origin", url));
      }
      if (doc && doc.readyState !== "loading" && doc.location.href !== "about:blank") {
        if (options.isReady(doc)) return finish();
        const html = doc.documentElement?.outerHTML ?? "";
        const elapsed = Date.now() - start;
        if (!revealed && elapsed > revealAfterMs && looksLikeChallenge(html)) {
          revealed = true;
          log.info("challenge needs the user; showing it", url);
          host.reveal(iframe, "请完成网站的人机验证，完成后会自动继续阅读", () =>
            finish(new FetchError("Challenge cancelled by the user", url, undefined, true)),
          );
        }
      }
      if (Date.now() - start > timeoutMs) finish(new FetchError("Timed out loading page in frame", url, undefined, true));
    };

    const poll = setInterval(check, 400);
    iframe.addEventListener("load", check);
    iframe.src = url;
    host.attach(iframe);
  });
}
