import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LIVE_SUBPROTOCOL } from "@stella/contracts/backend/protocol";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

let dev: WorkerdDev;

beforeAll(async () => {
  dev = await startWorkerdDev({
    config: "tests/fixtures/owner-store-workerd.wrangler.jsonc",
    prefix: "stella-owner-store-",
  });
}, 60_000);

afterAll(async () => {
  await dev?.stop();
});

const openLive = async (owner: string) => {
  const socket = new WebSocket(`${dev.origin.replace("http", "ws")}/live?owner=${owner}`, [LIVE_SUBPROTOCOL]);
  const frames: Array<Record<string, any>> = [];
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
  return { socket, frames };
};

const rpc = async (owner: string, name: string, args: unknown) =>
  (await dev.requestJson(`/rpc?owner=${owner}`, { name, args })).body;

describe("owner store in workerd", () => {
  test("live views follow calls and alarm-driven jobs", async () => {
    const live = await openLive("owner-a");
    expect(live.socket.protocol).toBe(LIVE_SUBPROTOCOL);
    live.socket.send(JSON.stringify({ t: "sub", id: "1", view: "notes.list", args: {} }));
    await dev.eventually(async () => live.frames.length, (count) => count >= 1);
    expect(live.frames[0]).toEqual({ t: "value", id: "1", value: [] });

    expect(await rpc("owner-a", "notes.add", { id: "a", body: "hello" })).toEqual({
      ok: true,
      value: { id: "a" },
    });
    await dev.eventually(async () => live.frames.length, (count) => count >= 2);
    expect(live.frames[1]).toEqual({ t: "value", id: "1", value: [{ id: "a", body: "hello" }] });

    expect(await rpc("owner-a", "notes.later", { delayMs: 300, id: "j" })).toEqual({
      ok: true,
      value: null,
    });
    await dev.eventually(async () => live.frames.length, (count) => count >= 3, 15_000);
    expect(live.frames[2]).toEqual({
      t: "value",
      id: "1",
      value: [
        { id: "a", body: "hello" },
        { id: "job-j", body: "from job" },
      ],
    });

    live.socket.send(JSON.stringify({ t: "ping" }));
    await dev.eventually(async () => live.frames.at(-1)?.t, (kind) => kind === "pong");
    live.socket.close();
  }, 60_000);

  test("owners are isolated", async () => {
    await rpc("owner-b", "notes.add", { id: "b", body: "mine" });
    const live = await openLive("owner-c");
    live.socket.send(JSON.stringify({ t: "sub", id: "1", view: "notes.list", args: {} }));
    await dev.eventually(async () => live.frames.length, (count) => count >= 1);
    expect(live.frames[0]).toEqual({ t: "value", id: "1", value: [] });
    live.socket.close();
  }, 30_000);
});
