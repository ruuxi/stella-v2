import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

const exchange = (
  origin: string,
  path: string,
  frames: (Uint8Array | string | number)[],
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
      }, 25_000);
      socket.addEventListener("open", async () => {
        for (const frame of frames) {
          if (typeof frame === "number") {
            await new Promise((resolve) => setTimeout(resolve, frame));
          } else if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        }
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

  test("an upgraded relay remains alive beyond the ten-second handshake deadline", async () => {
    const audio = new Uint8Array([5, 0, 6, 0]);
    const result = await exchange(
      dev.origin,
      "/relay",
      [audio, 11_000, audio, JSON.stringify({ type: "endStream" })],
      ["stella.v1"],
    );
    expect(result.code).toBe(1000);
    expect(result.messages).toEqual([
      { type: "transcript", final: true, text: "binary audio accepted" },
    ]);
    let settlement: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = (await (await fetch(`${dev.origin}/state`)).json()) as any;
      settlement = state.settlements.at(-1);
      if (settlement?.durationMs >= 11_000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settlement).toMatchObject({ audioBytes: 8, success: true });
    expect(settlement.durationMs).toBeGreaterThanOrEqual(11_000);
  }, 20_000);

  test("a provider that never upgrades still times out within ten seconds", async () => {
    const startedAt = Date.now();
    const response = await fetch(`${dev.origin}/relay?hang=1`);
    const elapsed = Date.now() - startedAt;
    expect(response.status).toBe(502);
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  test.each(["capped", "deadline"])(
    "flushes the final transcript at the %s allowance boundary",
    async (kind) => {
      const result = await exchange(
        dev.origin,
        `/relay?case=${kind}`,
        [new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])],
        ["stella.v1"],
      );
      expect(result.code).toBe(1000);
      expect(result.messages).toEqual([
        { type: "transcript", final: true, text: "binary audio accepted" },
      ]);
      let settlement: any;
      for (let i = 0; i < 50; i++) {
        const state = (await (
          await fetch(`${dev.origin}/state`)
        ).json()) as any;
        settlement = state.settlements.find(
          (row: any) => row.ownerId === `owner-${kind}`,
        );
        if (settlement) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(settlement).toMatchObject({
        audioBytes: kind === "capped" ? 6 : 8,
        success: true,
      });
    },
  );

  test("a deferred socket reserves nothing until start, then relays and settles", async () => {
    const state = async () =>
      (await (await fetch(`${dev.origin}/state`)).json()) as any;
    const before = await state();
    const audio = new Uint8Array([7, 0, 8, 0]);
    // A warm socket that never starts reserves nothing.
    await new Promise<void>((resolve) => {
      const idle = new WebSocket(
        dev.origin.replace("http:", "ws:") +
          "/relay?start=deferred&case=deferred-idle",
        ["stella.v1"],
      );
      idle.addEventListener("open", () =>
        setTimeout(() => {
          idle.close(1000);
          resolve();
        }, 300),
      );
    });
    expect((await state()).preparedSessionIds).toHaveLength(
      before.preparedSessionIds.length,
    );
    const result = await exchange(
      dev.origin,
      "/relay?start=deferred&case=deferred",
      [
        200,
        JSON.stringify({ type: "start" }),
        audio,
        JSON.stringify({ type: "endStream" }),
      ],
      ["stella.v1"],
    );
    expect(result.messages).toEqual([
      { type: "transcript", final: true, text: "binary audio accepted" },
    ]);
    let settlement: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      settlement = (await state()).settlements.find(
        (row: any) => row.ownerId === "owner-deferred",
      );
      if (settlement) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settlement).toMatchObject({ audioBytes: 4, success: true });
    const after = await state();
    expect(after.preparedSessionIds).toHaveLength(
      before.preparedSessionIds.length + 1,
    );
    expect(after.providerFrames.at(-1)).toEqual([...audio]);
  });

  test("a deferred socket rejects audio before start", async () => {
    const result = await exchange(
      dev.origin,
      "/relay?start=deferred",
      [new Uint8Array([1, 0])],
      ["stella.v1"],
    );
    expect(result.code).toBe(1008);
  });

  test("sends the provider handshake while prepare is still running", async () => {
    const result = await exchange(
      dev.origin,
      "/relay?case=slow-prepare",
      [new Uint8Array([9, 0]), JSON.stringify({ type: "endStream" })],
      ["stella.v1"],
    );
    expect(result.code).toBe(1000);
    const state = (await (await fetch(`${dev.origin}/state`)).json()) as any;
    expect(state.handshakeAt).toBeGreaterThan(0);
    expect(state.handshakeAt).toBeLessThan(state.prepareFinishedAt);
  });

  test("opens the provider during prepare but sends it no audio unless it commits", async () => {
    const before = (await (await fetch(`${dev.origin}/state`)).json()) as any;
    const result = await exchange(
      dev.origin,
      "/relay?case=exhausted",
      [],
      ["stella.v1"],
    );
    expect(result.code).toBe(1008);
    let state: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      state = await (await fetch(`${dev.origin}/state`)).json();
      if (state.providerSessionIds.length > before.providerSessionIds.length)
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const sessionId = state.providerSessionIds.at(-1);
    // Prepare reserved the same id the provider upgrade carried.
    expect(state.preparedSessionIds.at(-1)).toBe(sessionId);
    expect(sessionId).toMatch(/^muse_[0-9a-f-]{36}$/u);
    // A refused reservation sends the provider no audio.
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = await (await fetch(`${dev.origin}/state`)).json();
    expect(state.providerFrames).toEqual(before.providerFrames);
  });

  test("returns actionable exhausted-allowance errors over the socket", async () => {
    const result = await exchange(
      dev.origin,
      "/relay?case=exhausted",
      [],
      ["stella.v1"],
    );
    expect(result.code).toBe(1008);
    expect(result.messages).toEqual([
      { type: "error", message: "Your Stella usage allowance is exhausted." },
    ]);
  });
});
