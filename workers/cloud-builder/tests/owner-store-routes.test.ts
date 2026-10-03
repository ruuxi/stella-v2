import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setUserJwksForTests } from "../src/auth-jwt.js";
import { handleBackendRoute, handleRpc } from "../src/owner-store/routes.js";
import { object, string } from "../src/owner-store/args.js";
import { createOwnerRegistry, type OwnerDomain } from "../src/owner-store/registry.js";

// Refusals call `accept()` on the server end, which the shared fake lacks.
// Restored afterwards: bun shares globals across test files.
const scope = globalThis as unknown as { WebSocketPair?: unknown };
const originalPair = scope.WebSocketPair;
beforeAll(() => {
  scope.WebSocketPair = function PairWithAccept() {
    const end = () => ({ accept() {}, close() {}, send() {} });
    return [end(), end()];
  };
});
afterAll(() => {
  if (originalPair) scope.WebSocketPair = originalPair;
  else delete scope.WebSocketPair;
});

const originalFetch = globalThis.fetch;
const issuer = "https://auth-routes.test";
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const mint = async (claims: Record<string, unknown> = {}) => {
  const text = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${text({ alg: "RS256", kid: "k" })}.${text({
    iss: issuer,
    aud: "stella",
    sub: "user-1",
    sid: "s-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
};

const ownerCalls: unknown[] = [];
const forwardedLive: Request[] = [];
const env = {
  CLOUD_BUILDER_PUBLIC_URL: issuer,
  OWNER_GATES: {
    getByName: (name: string) => ({
      ownerRpc: async (input: unknown) => {
        ownerCalls.push({ name, input });
        return { ok: true, value: "from-owner" };
      },
      fetch: async (request: Request) => {
        forwardedLive.push(request);
        return new Response("upgraded");
      },
    }),
  },
} as unknown as Parameters<typeof handleRpc>[1];

const registry = createOwnerRegistry([
  {
    name: "test",
    calls: {
      "test.owner": { scope: "owner", parse: object({}), handler: () => null },
      "test.global": {
        scope: "global",
        parse: object({ who: string() }),
        handler: (ctx: any, args: { who: string }) => `${args.who}:${ctx.caller.subject}`,
      },
      "test.accountOnly": {
        scope: "global",
        requireAccount: true,
        parse: object({}),
        handler: () => "ok",
      },
    },
  } as unknown as OwnerDomain,
]);

const post = (name: string, args: unknown, token?: string) =>
  new Request(`https://api.test/api/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ args }),
  });

describe("backend routes", () => {
  beforeEach(async () => {
    ownerCalls.length = 0;
    forwardedLive.length = 0;
    await setUserJwksForTests({ keys: [{ ...publicKey, kid: "k" }] });
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await setUserJwksForTests(null);
  });

  test("routes owner calls to the caller's own object with the verified identity", async () => {
    const response = await handleRpc(post("test.owner", {}, await mint()), env, registry);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: "from-owner" });
    expect(ownerCalls).toEqual([
      {
        name: "user-1",
        input: {
          name: "test.owner",
          args: {},
          caller: expect.objectContaining({ ownerId: "user-1", subject: "user-1", sessionId: "s-1" }),
        },
      },
    ]);
  });

  test("runs global calls in the worker", async () => {
    const response = await handleRpc(post("test.global", { who: "me" }, await mint()), env, registry);
    expect(await response.json()).toEqual({ ok: true, value: "me:user-1" });
  });

  test("refuses missing, forged and anonymous callers", async () => {
    const missing = await handleRpc(post("test.owner", {}), env, registry);
    expect(missing.status).toBe(401);
    const [header, , signature] = (await mint()).split(".");
    const forgedPayload = encode(new TextEncoder().encode(JSON.stringify({
      iss: issuer, aud: "convex", sub: "someone-else", exp: Math.floor(Date.now() / 1000) + 600,
    })));
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect((await handleRpc(post("test.owner", {}, forged), env, registry)).status).toBe(401);
    const anonymous = await handleRpc(post("test.accountOnly", {}, await mint({ anon: true })), env, registry);
    expect(anonymous.status).toBe(403);
    expect(ownerCalls).toEqual([]);
  });

  test("reports unknown functions and bad args", async () => {
    expect((await handleRpc(post("test.nope", {}, await mint()), env, registry)).status).toBe(404);
    const bad = await handleRpc(post("test.global", { who: 1 }, await mint()), env, registry);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
  });

  test("forwards the live socket with trusted identity and strips client headers", async () => {
    const token = await mint();
    const request = new Request("https://api.test/owners/me/live", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `stella.live.v1, stella.token.${token}`,
        "x-stella-owner": "attacker",
      },
    });
    const response = await handleBackendRoute(request, env);
    expect(await response!.text()).toBe("upgraded");
    const forwarded = forwardedLive[0]!;
    expect(forwarded.headers.get("x-stella-owner")).toBe("user-1");
    expect(forwarded.headers.get("x-stella-anonymous")).toBe("0");
    expect(forwarded.headers.get("sec-websocket-protocol")).toBe("stella.live.v1");
  });

  test("refuses an unauthenticated live socket with a real close code", async () => {
    const request = new Request("https://api.test/owners/me/live", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "stella.live.v1" },
    });
    const response = await handleBackendRoute(request, env);
    expect(forwardedLive).toEqual([]);
    expect(response!.status).toBe(101);
  });

  test("leaves other paths alone", async () => {
    expect(await handleBackendRoute(new Request("https://api.test/conversations/x/socket"), env)).toBeNull();
  });
});
