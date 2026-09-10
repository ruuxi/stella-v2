import { convexTest } from "convex-test";
import schema from "../schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPlayableTtsPlaylist, type TtsPlaylist } from "./tts_playlist";

const pending: TtsPlaylist = {
  status: "synthesizing",
  done: false,
  segments: [],
};
afterEach(() => vi.useRealTimers());

describe("first mobile HLS playlist", () => {
  it("waits for the first segment but not the end of generation", async () => {
    vi.useFakeTimers();
    let current = pending;
    const read = vi.fn(async () => current);
    let returned = false;
    const response = waitForPlayableTtsPlaylist(read).then((value) => {
      returned = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(returned).toBe(false);
    current = { ...pending, segments: [{ seq: 0, durationSec: 2 }] };
    await vi.advanceTimersByTimeAsync(200);
    expect(await response).toEqual(current);
    expect(current.done).toBe(false);
  });

  it("returns immediately for existing audio, failed synthesis, or an invalid ticket", async () => {
    for (const value of [
      null,
      { ...pending, status: "error" as const, done: true },
      { ...pending, segments: [{ seq: 0, durationSec: 2 }] },
    ]) {
      const read = vi.fn(async () => value);
      expect(await waitForPlayableTtsPlaylist(read)).toEqual(value);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds a producer that never supplies audio", async () => {
    vi.useFakeTimers();
    const response = waitForPlayableTtsPlaylist(async () => pending);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await response).toEqual(pending);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks authority while waiting instead of serving a revoked ticket", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(null);
    const response = waitForPlayableTtsPlaylist(read);
    await vi.advanceTimersByTimeAsync(200);
    expect(await response).toBeNull();
  });
});

// Exercise the HTTP boundary too: helper readiness must never become a 200
// empty manifest, nor leak a different owner's cached audio.

const modules = import.meta.glob(["../**/*.ts", "../**/*.js"]);
describe("HLS playlist HTTP response", () => {
  it("serves ready audio and rejects empty or failed terminal sessions", async () => {
    const t = convexTest(schema, modules);
    const ownerId = "https://issuer.test|playlist-owner";
    const owner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "playlist-owner",
      tokenIdentifier: ownerId,
    });
    for (const [ticket, status, segments, expectedStatus] of [
      ["ready", "synthesizing", [{ seq: 0, durationSec: 2 }], 200],
      ["empty-done", "done", [], 502],
      ["failed-partial", "error", [{ seq: 0, durationSec: 2 }], 502],
    ] as const) {
      await t.run(async (ctx) => {
        await ctx.db.insert("tts_stream_tickets", {
          ticket,
          ownerId,
          ownerGeneration: "legacy",
          text: "test",
          voice: "Brooke",
          model: "inworld-tts-2-flash",
          hlsStatus: status,
          hlsSegments: [...segments],
          hlsDone: status !== "synthesizing",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
        });
      });
      const response = await owner.fetch(
        `/api/voice/tts/stream/hls/${ticket}/playlist.m3u8`,
      );
      expect(response.status).toBe(expectedStatus);
      if (response.ok) {
        const body = await response.text();
        expect(body).toContain("#EXTINF:2.000,");
        expect(body).not.toContain("#EXT-X-ENDLIST");
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    const other = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "other",
      tokenIdentifier: "https://issuer.test|other",
    });
    expect(
      (await other.fetch("/api/voice/tts/stream/hls/ready/playlist.m3u8"))
        .status,
    ).toBe(404);
  });
});
