import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineSettings } from "@stella/contracts/backend/engines";
import { openSqlStorageFake, type SqlStorageFake } from "./fixtures/sql-storage.js";
import { RATE_LIMIT_MIGRATION } from "../src/owner-store/rate-limit.js";
import {
  createOwnerRegistry,
  type OwnerCaller,
  type OwnerDomain,
} from "../src/owner-store/registry.js";
import { OwnerStore } from "../src/owner-store/store.js";
import {
  ENGINES_MIGRATION,
  enginesDomain,
} from "../src/owner-store/domains/engines.js";

const OWNER = "https://issuer.example|user-1";
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const caller: OwnerCaller = {
  ownerId: OWNER,
  subject: "user-1",
  sessionId: "session-1",
  isAnonymous: false,
  expiresAtMs: Date.now() + 30 * 60_000,
};

const ISSUER = "https://auth.openai.com";
const b64url = (bytes: Uint8Array | string): string => {
  const binary =
    typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** OpenAI's ID-token signing key, as the fake JWKS publishes it. */
const signingKey = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signingKey.publicKey)), kid: "test-key" };

const signIdToken = async (claims: Record<string, unknown>): Promise<string> => {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
};

/** One ChatGPT login: the registration ChatGPT issues for it (one per user). */
const chatGptLogin = (user: string, email: string) => ({
  user,
  email,
  clientId: `client-${user}`,
});
type ChatGptLogin = ReturnType<typeof chatGptLogin>;

type Harness = {
  store: OwnerStore;
  fake: SqlStorageFake;
  call: (name: string, args: unknown) => Promise<any>;
  settings: () => EngineSettings;
  access: (provider: string) => Promise<any>;
};

const createHarness = (fake = openSqlStorageFake()): Harness => {
  const store = new OwnerStore({
    ctx: {
      storage: { sql: fake.sql, transactionSync: <T>(fn: () => T) => fn() },
      getWebSockets: () => [],
    } as unknown as DurableObjectState,
    env: { OWNER_SECRETS_KEK: KEK } as unknown as Cloudflare.Env,
    ownerId: () => OWNER,
    registry: createOwnerRegistry([
      { name: "system", migrations: [RATE_LIMIT_MIGRATION] } as OwnerDomain,
      enginesDomain,
    ]),
    host: {
      snapshot: async () => {
        throw new Error("no snapshot in tests");
      },
    },
    verifyToken: async () => null,
  });
  const unwrap = (response: any) => {
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  };
  return {
    store,
    fake,
    call: async (name, args) => unwrap(await store.call(name, args, caller)),
    settings: () =>
      enginesDomain.views["engines.get"].read(store.context(caller)) as EngineSettings,
    access: async (provider) =>
      unwrap(await store.internalCall("engines.access", { provider })),
  };
};

const originalFetch = globalThis.fetch;
/** The login the next code exchange signs in, with the attempt's nonce. */
let nextLogin: { login: ChatGptLogin; nonce: string } | null = null;
let tokenRequests: URLSearchParams[] = [];

const fakeOpenAi = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/.well-known/openid-configuration")) {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
      token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
    });
  }
  if (url.endsWith("/jwks.json")) return Response.json({ keys: [publicJwk] });
  if (url.endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
  if (url.endsWith("/oauth/token")) {
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const pending = nextLogin;
    if (!pending || body.get("client_id") !== pending.login.clientId) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    nextLogin = null;
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: `access-${pending.login.user}`,
      refresh_token: `refresh-${pending.login.user}`,
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid profile email offline_access chatgpt.tokens.use.direct",
      id_token: await signIdToken({
        iss: ISSUER,
        aud: pending.login.clientId,
        sub: pending.login.user,
        email: pending.login.email,
        nonce: pending.nonce,
        iat: now,
        exp: now + 3_600,
      }),
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** Sign the cloud in: authorize, approve as `login`, paste the redirect back. */
const connectChatGpt = async (harness: Harness, login: ChatGptLogin) => {
  const { connectId, authorizeUrl, redirectUri } = await harness.call("engines.startConnect", {
    provider: "chatgpt",
  });
  const params = new URL(authorizeUrl).searchParams;
  nextLogin = { login, nonce: params.get("nonce")! };
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", `code-${login.user}`);
  callback.searchParams.set("state", params.get("state")!);
  callback.searchParams.set("client_id", login.clientId);
  return await harness.call("engines.finishConnect", {
    connectId,
    pastedInput: callback.toString(),
  });
};

describe("engine accounts", () => {
  let harness: Harness;
  beforeEach(() => {
    nextLogin = null;
    tokenRequests = [];
    globalThis.fetch = fakeOpenAi;
    harness = createHarness();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    harness.fake.close();
  });

  test("signs the cloud in as its own host and exchanges with the issued client", async () => {
    const { authorizeUrl, redirectUri } = await harness.call("engines.startConnect", {
      provider: "chatgpt",
    });
    const params = new URL(authorizeUrl).searchParams;
    expect(redirectUri).toBe("http://127.0.0.1:1455/auth/callback");
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("Stella");
    expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(params.get("code_challenge_method")).toBe("S256");

    const result = await connectChatGpt(harness, chatGptLogin("user-a", "a@example.com"));
    expect(result).toEqual({ accountId: expect.any(String), planUsage: true });
    expect(Object.fromEntries(tokenRequests[0]!)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "client-user-a",
      code: "code-user-a",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      resource: "https://api.openai.com/v1",
    });
    expect(harness.settings().connections).toEqual([
      expect.objectContaining({ provider: "chatgpt", email: "a@example.com", active: true, planUsage: true }),
    ]);
    // The host id persists: a second attempt carries the same one.
    const again = await harness.call("engines.startConnect", { provider: "chatgpt" });
    expect(new URL(again.authorizeUrl).searchParams.get("ext_agent_host_id")).toBe(
      params.get("ext_agent_host_id"),
    );
  });

  test("refuses a pasted redirect from a different attempt", async () => {
    const { connectId } = await harness.call("engines.startConnect", { provider: "chatgpt" });
    await expect(
      harness.call("engines.finishConnect", {
        connectId,
        pastedInput: "http://127.0.0.1:1455/auth/callback?code=x&state=other&client_id=client-x",
      }),
    ).rejects.toThrow("different attempt");
    expect(harness.settings().connections).toHaveLength(0);
  });

  test("adds a second login as a new active account and keeps a reconnect as one", async () => {
    await connectChatGpt(harness, chatGptLogin("user-a", "a@example.com"));
    await connectChatGpt(harness, chatGptLogin("user-b", "b@example.com"));

    let connections = harness.settings().connections;
    expect(connections.map((row) => [row.email, row.active])).toEqual([
      ["a@example.com", false],
      ["b@example.com", true],
    ]);

    // The first login signing in again replaces itself and becomes active.
    await connectChatGpt(harness, chatGptLogin("user-a", "a@example.com"));
    connections = harness.settings().connections;
    expect(connections).toHaveLength(2);
    expect(connections.find((row) => row.active)?.email).toBe("a@example.com");
  });

  test("switches the serving account and signs one account out", async () => {
    await connectChatGpt(harness, chatGptLogin("user-a", "a@example.com"));
    await connectChatGpt(harness, chatGptLogin("user-b", "b@example.com"));
    const [first, second] = harness.settings().connections;

    await harness.call("engines.setActiveAccount", {
      provider: "chatgpt",
      accountId: first!.accountId,
    });
    expect((await harness.access("chatgpt")).engineAccountId).toBe(first!.accountId);

    // Signing out revokes the session but keeps the registration.
    expect(
      await harness.call("engines.disconnect", {
        provider: "chatgpt",
        accountId: first!.accountId,
      }),
    ).toEqual({ revoked: true });
    expect(
      harness.settings().connections.map((row) => [row.accountId, row.active, row.status]),
    ).toEqual([
      [first!.accountId, false, "signed_out"],
      [second!.accountId, true, undefined],
    ]);
    expect((await harness.access("chatgpt")).engineAccountId).toBe(second!.accountId);

    // Forgetting removes it.
    await harness.call("engines.disconnect", {
      provider: "chatgpt",
      accountId: first!.accountId,
      forget: true,
    });
    expect(harness.settings().connections.map((row) => row.accountId)).toEqual([
      second!.accountId,
    ]);
  });

  test("a stored Claude credential from before is dropped on upgrade", async () => {
    const fake = openSqlStorageFake();
    // A store from before multiple accounts: only the first migration ran.
    fake.sql.exec(
      "CREATE TABLE _owner_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const statement of ENGINES_MIGRATION.statements) fake.sql.exec(statement);
    fake.sql.exec(
      "INSERT INTO _owner_migrations (id, applied_at) VALUES (?, ?)",
      ENGINES_MIGRATION.id,
      1,
    );
    fake.sql.exec(
      `INSERT INTO engine_credentials (provider, payload, label, created_at, updated_at)
       VALUES ('anthropic', 'v1.legacy.payload', 'Claude (Pro/Max subscription)', 5, 6)`,
    );
    const upgraded = createHarness(fake);

    const settings = upgraded.settings();
    expect(settings.connections).toEqual([]);
    expect(
      fake.sql.exec("SELECT COUNT(*) AS n FROM engine_accounts").one().n,
    ).toBe(0);
    fake.close();
  });
});
