import { describe, expect, it, vi } from "vitest";
import { retryImage } from "../src/ui/ReaderView";

describe("illustration retry", () => {
  it("asks once more past the cache, then shows the image again", async () => {
    const img = document.createElement("img");
    img.setAttribute("src", "/api/img?url=x");
    const fig = document.createElement("figure");
    const load = vi.fn(async () => new Response(null));
    await retryImage(img, fig, load as unknown as typeof fetch);
    expect(load).toHaveBeenCalledWith("/api/img?url=x", expect.objectContaining({ cache: "reload" }));
    expect(img.getAttribute("src")).toBe("/api/img?url=x");
    expect(fig.classList.contains("broken")).toBe(false);
    // A second failure marks it broken.
    img.dispatchEvent(new Event("error"));
    expect(fig.classList.contains("broken")).toBe(true);
  });

  it("still marks it broken when the retry request fails", async () => {
    const img = document.createElement("img");
    img.setAttribute("src", "https://img3.readpai.com/1.jpg");
    const fig = document.createElement("figure");
    await retryImage(img, fig, (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch);
    img.dispatchEvent(new Event("error"));
    expect(fig.classList.contains("broken")).toBe(true);
  });
});
