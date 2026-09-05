import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

describe("thin OrchestratorSession wrapper in real Workerd", () => {
  let dev: WorkerdDev;

  beforeAll(async () => {
    dev = await startWorkerdDev({
      config: "tests/fixtures/orchestrator-wrapper-workerd.wrangler.jsonc",
      prefix: "stella-orchestrator-wrapper-workerd-",
    });
  }, 30_000);

  afterAll(async () => {
    await dev?.stop();
  }, 30_000);

  test("forwards public RPC methods, fetch, and constructor reader registration", async () => {
    const conversationId = `wrapper-${crypto.randomUUID()}`;
    const reader = await dev.requestJson(`/reader/${conversationId}`);
    expect(reader.status).toBe(200);
    expect(typeof reader.body.readerId).toBe("string");
    expect(String(reader.body.readerId).length).toBeGreaterThan(0);

    expect(await dev.requestJson(`/freeze/${conversationId}`)).toEqual({
      status: 200,
      body: { frozen: true },
    });
    expect(await dev.requestJson(`/cancel/${conversationId}`)).toEqual({
      status: 400,
      body: { canceled: false, reason: "exact_turn_identity_required" },
    });
  }, 60_000);

  test("loads the real conversation hub and registers the reader on a bound wake", async () => {
    const conversationId = `socket-${crypto.randomUUID()}`;
    const socket = new WebSocket(
      `${dev.origin.replace("http://", "ws://")}/socket/${conversationId}`,
      "stella.v1",
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`socket did not open:\n${dev.output()}`)),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error(`socket errored during open:\n${dev.output()}`));
        },
        { once: true },
      );
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close(1000, "done");

    await dev.restart();
    const reader = await dev.requestJson(`/reader/${conversationId}`);
    expect(reader.status).toBe(200);
    await dev.eventually(
      () => dev.requestJson("/registrations/owner-1"),
      (response) =>
        response.status === 200 &&
        Array.isArray(response.body.registrations) &&
        response.body.registrations.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>).conversationId ===
              conversationId &&
            (entry as Record<string, unknown>).readerId ===
              reader.body.readerId,
        ),
    );
  }, 60_000);
});
