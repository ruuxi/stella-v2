import { describe, expect, test } from "bun:test";
import { BackendClient, BackendRequestError, stableStringify } from "./client.js";
import { LIVE_CLOSE, LIVE_SUBPROTOCOL } from "./protocol.js";

type Sent = Record<string, unknown>;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Sent[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const createClient = (options: { tokens?: string[]; fetch?: typeof fetch } = {}) => {
  FakeSocket.instances = [];
  const tokenCalls: Array<{ force?: boolean } | undefined> = [];
  const tokens = [...(options.tokens ?? ["t1", "t2", "t3"])];
  const client = new BackendClient({
    baseUrl: "https://api.example/",
    getToken: async (opts) => {
      tokenCalls.push(opts);
      return tokens.shift() ?? "t-last";
    },
    WebSocket: FakeSocket as never,
    maxReconnectDelayMs: 1,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { client, tokenCalls };
};

describe("BackendClient.call", () => {
  test("posts args with the bearer token and returns the value", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { client } = createClient({
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return Response.json({ ok: true, value: { now: 5 } });
      }) as unknown as typeof fetch,
    });
    expect(await client.call("system.ping", {})).toEqual({ now: 5 });
    expect(requests[0]!.url).toBe("https://api.example/api/rpc/system.ping");
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t1");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ args: {} });
  });

  test("retries once with a forced token after a 401", async () => {
    let attempt = 0;
    const { client, tokenCalls } = createClient({
      fetch: (async () => {
        attempt += 1;
        return attempt === 1
          ? Response.json(
              { ok: false, error: { code: "UNAUTHENTICATED", message: "expired", retryable: false } },
              { status: 401 },
            )
          : Response.json({ ok: true, value: { now: 1 } });
      }) as unknown as typeof fetch,
    });
    expect(await client.call("system.ping", {})).toEqual({ now: 1 });
    expect(tokenCalls).toEqual([undefined, { force: true }]);
  });

  test("throws the backend error", async () => {
    const { client } = createClient({
      fetch: (async () =>
        Response.json(
          { ok: false, error: { code: "CONFLICT", message: "Already there.", retryable: false } },
          { status: 409 },
        )) as unknown as typeof fetch,
    });
    const error = await client.call("system.ping", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(BackendRequestError);
    expect(error).toMatchObject({ code: "CONFLICT", message: "Already there." });
  });
});

describe("BackendClient.watch", () => {
  const watchAny = (client: BackendClient, view: string, args: unknown, onValue: (value: unknown) => void, onError?: (error: BackendRequestError) => void) =>
    (client as unknown as {
      watch: (view: string, args: unknown, onValue: (value: unknown) => void, onError?: (error: BackendRequestError) => void) => () => void;
    }).watch(view, args, onValue, onError);

  test("opens one socket with the token subprotocol and shares identical subscriptions", async () => {
    const { client } = createClient();
    const first: unknown[] = [];
    const second: unknown[] = [];
    watchAny(client, "notes.list", { a: 1, b: 2 }, (value) => first.push(value));
    watchAny(client, "notes.list", { b: 2, a: 1 }, (value) => second.push(value));
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://api.example/owners/me/live");
    expect(socket.protocols).toEqual([LIVE_SUBPROTOCOL, "stella.token.t1"]);
    socket.open();
    expect(socket.sent).toEqual([{ t: "sub", id: "1", view: "notes.list", args: { a: 1, b: 2 } }]);
    socket.receive({ t: "value", id: "1", value: ["x"] });
    expect(first).toEqual([["x"]]);
    expect(second).toEqual([["x"]]);

    // A late subscriber gets the cached value immediately.
    const third: unknown[] = [];
    watchAny(client, "notes.list", { a: 1, b: 2 }, (value) => third.push(value));
    expect(third).toEqual([["x"]]);
    client.dispose();
  });

  test("unsubscribes when the last listener leaves", async () => {
    const { client } = createClient();
    const stopA = watchAny(client, "v", {}, () => {});
    const stopB = watchAny(client, "v", {}, () => {});
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    stopA();
    expect(socket.sent.filter((frame) => frame.t === "unsub")).toEqual([]);
    stopB();
    expect(socket.sent.at(-1)).toEqual({ t: "unsub", id: "1" });
    client.dispose();
  });

  test("resubscribes after a drop and forces a token after an auth close", async () => {
    const { client, tokenCalls } = createClient();
    const values: unknown[] = [];
    watchAny(client, "v", { k: 1 }, (value) => values.push(value));
    await flush();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop(LIVE_CLOSE.unauthenticated);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(tokenCalls.at(-1)).toEqual({ force: true });
    const next = FakeSocket.instances[1]!;
    next.open();
    expect(next.sent).toEqual([{ t: "sub", id: "1", view: "v", args: { k: 1 } }]);
    next.receive({ t: "value", id: "1", value: 7 });
    expect(values).toEqual([7]);
    client.dispose();
  });

  test("answers reauth with an auth frame", async () => {
    const { client } = createClient({ tokens: ["old", "new"] });
    watchAny(client, "v", {}, () => {});
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ t: "reauth", expiresAtMs: Date.now() + 60_000 });
    await flush();
    expect(socket.sent.at(-1)).toEqual({ t: "auth", token: "new" });
    client.dispose();
  });

  test("delivers view errors and stops on protocol refusal", async () => {
    const { client } = createClient();
    const errors: string[] = [];
    watchAny(client, "v", {}, () => {}, (error) => errors.push(error.code));
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ t: "error", id: "1", error: { code: "FORBIDDEN", message: "no", retryable: false } });
    socket.drop(LIVE_CLOSE.protocol);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual(["FORBIDDEN", "BAD_REQUEST"]);
    expect(FakeSocket.instances).toHaveLength(1);
    client.dispose();
  });
});

test("stableStringify sorts keys and drops undefined", () => {
  expect(stableStringify({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 0 }] } })).toBe(
    '{"a":{"c":[2,{"y":0,"z":1}]},"b":1}',
  );
});
