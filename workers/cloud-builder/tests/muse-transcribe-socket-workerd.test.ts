import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

const exchange = (
  origin: string,
  path: string,
  frames: (Uint8Array | string)[],
  protocols?: string[],
) =>
  new Promise<{ messages: unknown[]; code: number; reason: string }>(
    (resolve, reject) => {
      const socket = new WebSocket(
        origin.replace("http:", "ws:") + path,
        protocols,
      );
      const messages: unknown[] = [];
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket proof timed out"));
      }, 10_000);
      socket.addEventListener("open", () => {
        for (const frame of frames) socket.send(frame);
      });
      socket.addEventListener("message", (event) =>
        messages.push(JSON.parse(String(event.data))),
      );
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket proof failed"));
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve({ messages, code: event.code, reason: event.reason });
      });
    },
  );

describe("Muse PCM relay in real Workerd", () => {
  let dev: WorkerdDev;
  beforeAll(async () => {
    dev = await startWorkerdDev({
      config: "tests/fixtures/muse-transcribe-socket-workerd.wrangler.jsonc",
      prefix: "stella-muse-pcm-workerd-",
    });
  });
  afterAll(async () => {
    await dev?.stop();
  });

  test("the deployed compatibility date delivers binary as Blob by default", async () => {
    const result = await exchange(dev.origin, "/default-binary", [
      new Uint8Array([1, 2]),
    ]);
    expect(result.code).toBe(1000);
    expect(result.messages).toEqual([
      { binaryType: "blob", isBlob: true, isArrayBuffer: false },
    ]);
  });

  test("the actual relay forwards ordered PCM bytes and settles nonzero usage", async () => {
    const audio = [
      new Uint8Array([0, 1, 255, 127]),
      new Uint8Array([0, 128, 42, 0]),
    ];
    const result = await exchange(
      dev.origin,
      "/relay",
      [...audio, JSON.stringify({ type: "endStream" })],
      ["stella.v1"],
    );
    expect(result.code).toBe(1000);
    expect(result.messages).toEqual([
      { type: "transcript", final: true, text: "binary audio accepted" },
    ]);
    let state: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      state = await (await fetch(`${dev.origin}/state`)).json();
      if (state.settlements.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state.handshakes).toBe(1);
    expect(state.providerFrames).toEqual(audio.map((frame) => [...frame]));
    expect(state.settlements).toHaveLength(1);
    expect(state.settlements[0]).toMatchObject({
      sessionId: "muse-fixture",
      ownerId: "owner-fixture",
      ownerGeneration: "generation-1",
      audioBytes: 8,
      success: true,
    });
  });
});
