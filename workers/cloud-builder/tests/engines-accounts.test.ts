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

const jwt = (claims: Record<string, unknown>): string =>
  `x.${btoa(JSON.stringify(claims)).replaceAll("=", "")}.y`;

/** One ChatGPT login: its tokens name the user, email, and plan. */
const codexLogin = (user: string, email: string, plan: string) => {
  const access = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: `workspace-${user}`,
      chatgpt_user_id: user,
      chatgpt_plan_type: plan,
    },
  });
  return {
    access_token: access,
    refresh_token: `refresh-${user}`,
    expires_in: 3_600,
    id_token: jwt({ sub: user, email }),
  };
};

type Harness = {
  store: OwnerStore;
  fake: SqlStorageFake;
  call: (name: string, args: unknown) => Promise<any>;
  settings: () => EngineSettings;
  access: (provider: string) => Promise<any>;
  limit: (args: Record<string, unknown>) => Promise<any>;
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
    limit: async (args) => unwrap(await store.internalCall("engines.limit", args)),
  };
};

const originalFetch = globalThis.fetch;
let tokenResponses: unknown[] = [];

const connectCodex = async (harness: Harness, login: ReturnType<typeof codexLogin>) => {
  tokenResponses.push(login);
  const { connectId } = await harness.call("engines.startConnect", {
    provider: "openai-codex",
  });
  await harness.call("engines.finishConnect", {
    connectId,
    pastedInput: "http://localhost:1455/auth/callback?code=abc",
  });
};

describe("engine accounts", () => {
  let harness: Harness;
  beforeEach(() => {
    tokenResponses = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/oauth/token")) {
        return Response.json(tokenResponses.shift());
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    harness = createHarness();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    harness.fake.close();
  });

  test("adds a second login as a new active account and keeps a reconnect as one", async () => {
    await connectCodex(harness, codexLogin("user-a", "a@example.com", "plus"));
    await connectCodex(harness, codexLogin("user-b", "b@example.com", "pro"));

    let connections = harness.settings().connections;
    expect(connections.map((row) => [row.email, row.plan, row.active])).toEqual([
      ["a@example.com", "Plus", false],
      ["b@example.com", "Pro", true],
    ]);

    // The first login signing in again replaces itself and becomes active.
    await connectCodex(harness, codexLogin("user-a", "a@example.com", "plus"));
    connections = harness.settings().connections;
    expect(connections).toHaveLength(2);
    expect(connections.find((row) => row.active)?.email).toBe("a@example.com");
  });

  test("switches the serving account and signs one account out", async () => {
    await connectCodex(harness, codexLogin("user-a", "a@example.com", "plus"));
    await connectCodex(harness, codexLogin("user-b", "b@example.com", "pro"));
    const [first, second] = harness.settings().connections;

    await harness.call("engines.setActiveAccount", {
      provider: "openai-codex",
      accountId: first!.accountId,
    });
    expect((await harness.access("openai-codex")).engineAccountId).toBe(first!.accountId);

    await harness.call("engines.disconnect", {
      provider: "openai-codex",
      accountId: first!.accountId,
    });
    const remaining = harness.settings().connections;
    expect(remaining.map((row) => [row.accountId, row.active])).toEqual([
      [second!.accountId, true],
    ]);
    expect((await harness.access("openai-codex")).engineAccountId).toBe(second!.accountId);
  });

  test("cools a limited account down and auto-switches only when enabled", async () => {
    await connectCodex(harness, codexLogin("user-a", "a@example.com", "plus"));
    await connectCodex(harness, codexLogin("user-b", "b@example.com", "pro"));
    const [first, second] = harness.settings().connections;
    await harness.call("engines.setActiveAccount", {
      provider: "openai-codex",
      accountId: first!.accountId,
    });
    const resetsAt = Date.now() + 2 * 60 * 60_000;

    // Auto-switch off: the account cools down but keeps serving.
    expect(
      await harness.limit({
        provider: "openai-codex",
        engineAccountId: first!.accountId,
        resetsAt,
      }),
    ).toEqual({ switched: false });
    let rows = harness.settings().connections;
    expect(rows[0]).toMatchObject({ active: true, limitedUntil: resetsAt });

    // Auto-switch on: the next request is served by the other account.
    await harness.call("engines.setAutoSwitch", {
      provider: "openai-codex",
      enabled: true,
    });
    expect((await harness.access("openai-codex")).engineAccountId).toBe(second!.accountId);
    rows = harness.settings().connections;
    expect(rows.map((row) => row.active)).toEqual([false, true]);
    expect(harness.settings().autoSwitch["openai-codex"]).toBe(true);

    // The second account hitting its limit with nothing left: no switch.
    expect(
      await harness.limit({
        provider: "openai-codex",
        engineAccountId: second!.accountId,
      }),
    ).toEqual({ switched: false });
  });

  test("an existing single credential becomes the provider's active account", async () => {
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
    expect(settings.connections).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        label: "Claude (Pro/Max subscription)",
        active: true,
        updatedAt: 6,
      }),
    ]);
    expect(settings.autoSwitch).toEqual({ anthropic: false, "openai-codex": false });
    fake.close();
  });
});
