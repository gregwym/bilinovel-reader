// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { holdAudioSession, releaseAudioSession } from "../src/speech/keepAlive";

describe("keepAlive", () => {
  it("loops silence while held and stops it on release", () => {
    URL.createObjectURL ??= () => "blob:silence";
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(false);
    holdAudioSession();
    expect(play).toHaveBeenCalledTimes(1);
    expect((play.mock.contexts[0] as HTMLAudioElement).loop).toBe(true);
    releaseAudioSession();
    expect(pause).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
