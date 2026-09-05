import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  GATEWAY_CAPABILITY_ISSUERS,
  type GatewayCapabilityClaims,
  type GatewayJwks,
} from "@stella/contracts/gateway/capability";
import {
  generateCapabilityKeyPair,
  importCapabilitySigningKey,
  signCapability,
  type CapabilitySigningKey,
  type UnsignedCapabilityClaims,
} from "@stella/contracts/gateway/jwt";
import {
  deviceKeyHash,
  deviceKeyProofForExchange,
  dpopHeaders,
  exportRawPublicKey,
  generateDpopKeyPair,
  type DpopAlgorithm,
} from "@stella/contracts/gateway/dpop";
import type { GatewayConfigSnapshot } from "@stella/contracts/gateway/usage";

// `cloudflare:workers` only exists inside workerd. The ledger DO extends its
// DurableObject base, so the mock must be registered before that module is
// evaluated — hence the dynamic import below and the rule that test files
// never import `src/index.ts` or `src/ledger.ts` statically.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

const ledgerModule = await import("../../src/ledger.js");
export const { CapabilityLedger } = ledgerModule;
export type CapabilityLedgerInstance = InstanceType<typeof CapabilityLedger>;
const ownerLedgerModule = await import("../../src/owner-capability-ledger.js");
export const { OwnerCapabilityLedger } = ownerLedgerModule;
export type OwnerCapabilityLedgerInstance = InstanceType<
  typeof OwnerCapabilityLedger
>;

export const createOwnerCapabilityLedgerNamespace = (envRef: () => unknown) => {
  const objects = new Map<string, OwnerCapabilityLedgerInstance>();
  const states = new Map<string, ReturnType<typeof createDurableObjectState>>();
  return {
    objects,
    states,
    namespace: {
      getByName: (name: string) => {
        let object = objects.get(name);
        if (!object) {
          const state = createDurableObjectState(name);
          states.set(name, state);
          object = new OwnerCapabilityLedger(state as never, envRef() as never);
          objects.set(name, object);
        }
        return object;
      },
    },
  };
};

const gateModule = await import("../../src/gates/index.js");
export const { NetworkGate, OwnerRelayGate, TierBudget } = gateModule;
export type NetworkGateInstance = InstanceType<typeof NetworkGate>;
export type OwnerRelayGateInstance = InstanceType<typeof OwnerRelayGate>;
export type TierBudgetInstance = InstanceType<typeof TierBudget>;

export const CONVEX_SITE = "https://outgoing-bulldog-865.convex.site";
export const OWNER_ID = `${CONVEX_SITE}|user_test_1`;
export const SERVICE_SECRET = "gateway-service-secret-for-tests";
export const PROBE_SECRET = "relay-probe-secret-for-tests";
export const OPENROUTER_KEY = "sk-or-v1-openrouter-test-key-0123456789";
export const CROF_KEY = "crof-test-key-0123456789abcdef";

// ---------------------------------------------------------------------------
// SqlStorage shim on bun:sqlite so the real DO class runs its real SQL.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const createSqlStorage = () => {
  let db = new Database(":memory:");
  const cursor = (rows: Row[]) => ({
    toArray: () => rows,
    one: () => {
      const first = rows[0];
      if (!first) throw new Error("no rows");
      return first;
    },
    next: () => ({ done: true as const }),
    raw: () => rows.map((row) => Object.values(row))[Symbol.iterator](),
    columnNames: rows[0] ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten: 0,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as never[])) as Row[];
      return cursor(rows);
    },
    reset() {
      db.close();
      db = new Database(":memory:");
    },
    get databaseSize() {
      return 0;
    },
  };
};

export const createDurableObjectState = (name: string) => {
  let alarm: number | null = null;
  const sql = createSqlStorage();
  const values = new Map<string, unknown>();
  const storage = {
    kv: {
      get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    },
    sql,
    transactionSync: <T>(fn: () => T): T => {
      sql.exec("BEGIN");
      try { const result = fn(); sql.exec("COMMIT"); return result; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number | Date) => {
      alarm = at instanceof Date ? at.getTime() : at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    deleteAll: async () => {
      sql.reset();
      values.clear();
      alarm = null;
    },
  };
  return {
    id: { name, toString: () => name },
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    waitUntil: (_promise: Promise<unknown>) => undefined,
    alarmAt: () => alarm,
  };
};

export const createLedgerNamespace = (envRef: () => unknown) => {
  const objects = new Map<string, CapabilityLedgerInstance>();
  const states = new Map<string, ReturnType<typeof createDurableObjectState>>();
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => {
      let object = objects.get(id.name);
      if (!object) {
        const state = createDurableObjectState(id.name);
        states.set(id.name, state);
        object = new CapabilityLedger(state as never, envRef() as never);
        objects.set(id.name, object);
      }
      return object;
    },
  };
  return { namespace, objects, states };
};

export const createOwnerRelayGateNamespace = (envRef: () => unknown) => {
  const objects = new Map<string, OwnerRelayGateInstance>();
  let relayFetch: ((request: Request, owner: string, object: OwnerRelayGateInstance) => Promise<Response>) | undefined;
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => {
      let object = objects.get(id.name);
      if (!object) {
        object = new OwnerRelayGate(
          createDurableObjectState(id.name) as never,
          envRef() as never,
        );
        const target = object;
        const originalFetch = target.fetch.bind(target);
        target.fetch = request => relayFetch ? relayFetch(request, id.name, target) : originalFetch(request);
        objects.set(id.name, object);
      }
      return object;
    },
  };
  return { namespace, objects, setFetch: (fetch: NonNullable<typeof relayFetch>) => { relayFetch = fetch; } };
};

export const createNetworkGateNamespace = (envRef: () => unknown) => {
  const objects = new Map<string, NetworkGateInstance>();
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => {
      let object = objects.get(id.name);
      if (!object) {
        object = new NetworkGate(
          createDurableObjectState(id.name) as never,
          envRef() as never,
        );
        objects.set(id.name, object);
      }
      return object;
    },
  };
  return { namespace, objects };
};

export const createTierBudgetNamespace = (envRef: () => unknown) => {
  const objects = new Map<string, TierBudgetInstance>();
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => {
      let object = objects.get(id.name);
      if (!object) {
        object = new TierBudget(
          createDurableObjectState(id.name) as never,
          envRef() as never,
        );
        objects.set(id.name, object);
      }
      return object;
    },
  };
  return { namespace, objects };
};

// ---------------------------------------------------------------------------
// Capability issuers
// ---------------------------------------------------------------------------

type Issuer = { kid: string; signing: CapabilitySigningKey; jwk: JsonWebKey };

const makeIssuer = async (kid: string): Promise<Issuer> => {
  const pair = await generateCapabilityKeyPair();
  return {
    kid,
    jwk: pair.publicJwk,
    signing: await importCapabilitySigningKey(pair.privateKeyPem, kid),
  };
};

export const issuers = {
  convex: await makeIssuer("convex-k1"),
  cloudBuilder: await makeIssuer("cb-k1"),
  /** Valid key pair that is NOT in the gateway's JWKS. */
  rogue: await makeIssuer("rogue-k1"),
};

export const jwks: GatewayJwks = {
  keys: [
    {
      kid: issuers.convex.kid,
      jwk: issuers.convex.jwk,
      issuer: GATEWAY_CAPABILITY_ISSUERS.convex,
    },
    {
      kid: issuers.cloudBuilder.kid,
      jwk: issuers.cloudBuilder.jwk,
      issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
    },
  ],
};

export const MUSE_ALIAS = "stella/meta/muse-spark-1.3-contributor";
export const CROF_ALIAS = "stella/crof/deepseek-v4-flash-0731";
export const MUSE_RESOLVED = "meta/muse-spark-1.3-contributor";
export const CROF_RESOLVED = "crof/deepseek-v4-flash-0731";

const baseSessionClaims = (): UnsignedCapabilityClaims => ({
  iss: GATEWAY_CAPABILITY_ISSUERS.convex,
  sub: OWNER_ID,
  gen: "gen-1",
  kind: "session",
  audience: "pro",
  budgetMicroCents: 50_000_000,
  dpk: TEST_DEVICE_KEY_HASH,
});

const testDevice = await (async () => {
  const generated = await generateDpopKeyPair();
  const rawPublicKey = await exportRawPublicKey(generated.keyPair.publicKey);
  return {
    alg: generated.alg,
    privateKey: generated.keyPair.privateKey,
    rawPublicKey,
    hash: await deviceKeyHash(rawPublicKey),
  };
})();

export const TEST_DEVICE_KEY_HASH = testDevice.hash;

type SessionDpopIdentity = {
  claims: GatewayCapabilityClaims;
  alg: DpopAlgorithm;
  privateKey: CryptoKey;
  rawPublicKey: Uint8Array;
};

const sessionDpopIdentities = new Map<string, SessionDpopIdentity>();

export const signSession = async (
  overrides: Partial<UnsignedCapabilityClaims> = {},
  options: { ttlMs?: number; now?: number; key?: CapabilitySigningKey } = {},
): Promise<{ token: string; claims: GatewayCapabilityClaims }> => {
  const signed = await signCapability(
    { ...baseSessionClaims(), ...overrides },
    options.key ?? issuers.convex.signing,
    { ttlMs: options.ttlMs ?? 60 * 60_000, now: options.now },
  );
  sessionDpopIdentities.set(signed.token, {
    claims: signed.claims,
    alg: testDevice.alg,
    privateKey: testDevice.privateKey,
    rawPublicKey: testDevice.rawPublicKey,
  });
  return signed;
};

export const testDeviceKeyProof = async (args: {
  ownerId: string;
  gatewayOrigin?: string;
  now?: number;
}) =>
  await deviceKeyProofForExchange({
    alg: testDevice.alg,
    privateKey: testDevice.privateKey,
    rawPublicKey: testDevice.rawPublicKey,
    ownerId: args.ownerId,
    gatewayOrigin: args.gatewayOrigin ?? "https://gateway.test",
    now: args.now ?? Date.now(),
  });

let testRequestSequence = 0;

/** Add a valid proof for session tokens minted by `signSession`. */
export const withTestDpop = async (
  request: Request,
  options: { now?: number; requestId?: string | null } = {},
): Promise<Request> => {
  const token = /^Bearer\s+(\S+)$/iu.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  const identity = token ? sessionDpopIdentities.get(token) : undefined;
  if (!identity) return request;
  const headers = new Headers(request.headers);
  const requestId =
    options.requestId === null
      ? ""
      : (options.requestId ?? headers.get("x-stella-request-id")?.trim()) ||
        `test-dpop-${++testRequestSequence}`;
  if (requestId) headers.set("x-stella-request-id", requestId);
  else headers.delete("x-stella-request-id");
  const proof = await dpopHeaders({
    alg: identity.alg,
    privateKey: identity.privateKey,
    rawPublicKey: identity.rawPublicKey,
    method: request.method,
    pathname: new URL(request.url).pathname,
    jti: identity.claims.jti,
    requestId,
    now: options.now ?? Date.now(),
  });
  for (const [name, value] of Object.entries(proof)) headers.set(name, value);
  const proven = new Request(request, { headers });
  if ("cf" in request) {
    Object.defineProperty(proven, "cf", { value: request.cf });
  }
  return proven;
};

export const signTurn = async (
  overrides: Partial<UnsignedCapabilityClaims> = {},
  options: { ttlMs?: number; now?: number; key?: CapabilitySigningKey } = {},
): Promise<{ token: string; claims: GatewayCapabilityClaims }> =>
  signCapability(
    {
      iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
      sub: OWNER_ID,
      gen: "gen-1",
      kind: "turn",
      audience: "pro",
      budgetMicroCents: 50_000_000,
      agentTypes: ["orchestrator"],
      turn: {
        turnId: "turn_1",
        conversationId: "conv_1",
        execution: {
          engine: "stella",
          provider: "stella",
          model: MUSE_ALIAS,
          reasoningEffort: "xhigh",
        },
      },
      ...overrides,
    },
    options.key ?? issuers.cloudBuilder.signing,
    { ttlMs: options.ttlMs ?? 30 * 60_000, now: options.now },
  );

// ---------------------------------------------------------------------------
// Routed fetch mock
// ---------------------------------------------------------------------------

export type FetchCall = {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null | undefined;
};

type Responder = (call: FetchCall) => Response | Promise<Response>;

export const createFetchMock = () => {
  const calls: FetchCall[] = [];
  const routes: Array<{
    test: (call: FetchCall) => boolean;
    respond: Responder;
  }> = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
    );
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: typeof init.body === "string" ? init.body : null,
      signal: init.signal,
    };
    calls.push(call);
    for (const route of routes) {
      if (route.test(call)) return await route.respond(call);
    }
    return new Response(`unrouted ${url.href}`, { status: 599 });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    on(test: (call: FetchCall) => boolean, respond: Responder) {
      routes.unshift({ test, respond });
      return this;
    },
    callsTo(host: string) {
      return calls.filter((call) => call.url.host === host);
    },
  };
};

export const configSnapshot = (
  overrides: Partial<GatewayConfigSnapshot> = {},
): GatewayConfigSnapshot => ({
  v: 1,
  prices: [
    {
      model: MUSE_RESOLVED,
      inputPerMillionUsd: 0.1,
      outputPerMillionUsd: 0.2,
      cacheReadPerMillionUsd: 0.002,
      cacheWritePerMillionUsd: 0,
      reasoningPerMillionUsd: 0.2,
    },
    {
      model: CROF_RESOLVED,
      inputPerMillionUsd: 0.12,
      outputPerMillionUsd: 0.21,
      cacheReadPerMillionUsd: 0.003,
      cacheWritePerMillionUsd: 0,
      reasoningPerMillionUsd: 0.21,
    },
  ],
  anonymous: { maxRequestsPerOwner: 20, maxRequestsPerIp: 60 },
  tierCeilings: [],
  updatedAt: 1_756_000_000_000,
  ...overrides,
});

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// ---------------------------------------------------------------------------
// SSE fixtures
// ---------------------------------------------------------------------------

export type SseFixtureFrame = { event?: string; data: unknown };

export const sseText = (frames: SseFixtureFrame[], newline = "\n"): string =>
  frames
    .map(
      (frame) =>
        `${frame.event ? `event: ${frame.event}${newline}` : ""}data: ${
          typeof frame.data === "string"
            ? frame.data
            : JSON.stringify(frame.data)
        }${newline}${newline}`,
    )
    .join("");

/** Stream `text` in uneven byte-sized chunks to exercise decoder boundaries. */
export const chunkedStream = (
  text: string,
  chunkSize = 7,
): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, next));
      offset = next;
    },
  });
};

export const sseResponse = (
  text: string,
  options: { status?: number; chunkSize?: number } = {},
): Response =>
  new Response(chunkedStream(text, options.chunkSize), {
    status: options.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });

/** Emits one frame, then errors the stream when `signal` aborts. */
export const hangingSseResponse = (
  firstFrame: string,
  signal: AbortSignal | null | undefined,
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstFrame));
        signal?.addEventListener("abort", () => {
          controller.error(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        });
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

// ---------------------------------------------------------------------------
// Worker env
// ---------------------------------------------------------------------------

export const createTestEnv = (overrides: Record<string, unknown> = {}) => {
  const usageEvents: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const limiter = { success: true, keys: [] as string[] };
  let env: Record<string, unknown> = {};
  const ledger = createLedgerNamespace(() => env);
  const ownerLedger = createOwnerCapabilityLedgerNamespace(() => env);
  const ownerGate = createOwnerRelayGateNamespace(() => env);
  const networkGate = createNetworkGateNamespace(() => env);
  const tierBudget = createTierBudgetNamespace(() => env);
  const enforcementValues = new Map<string, string>();
  const asnPolicyValues = new Map<string, string>();
  const asnPolicyCalls: Array<{
    key: string;
    cacheTtl: number | undefined;
  }> = [];
  const enforcementCalls: Array<
    | { kind: "get"; key: string; cacheTtl: number | undefined }
    | {
        kind: "put";
        key: string;
        value: string;
        expirationTtl: number | undefined;
      }
    | { kind: "delete"; key: string }
  > = [];
  env = {
    ENVIRONMENT: "development",
    STELLA_CONVEX_SITE_URL: CONVEX_SITE,
    CAPABILITY_JWKS: JSON.stringify(jwks),
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    FIREWORKS_API_KEY: "fw-test",
    DEEPSEEK_API_KEY: "sk-deepseek-test",
    CROF_API_KEY: CROF_KEY,
    WAFER_API_KEY: "wafer-test",
    XAI_API_KEY: "xai-test",
    OPENAI_API_KEY: "sk-openai-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    GOOGLE_AI_API_KEY: "AIza-test",
    META_MODEL_API_KEY: "meta-test",
    GATEWAY_SERVICE_SECRET: SERVICE_SECRET,
    STELLA_RELAY_PROBE_SECRET: PROBE_SECRET,
    CAPABILITY_LEDGER: ledger.namespace,
    OWNER_CAPABILITY_LEDGER: ownerLedger.namespace,
    OWNER_RELAY_GATE: ownerGate.namespace,
    NETWORK_GATE: networkGate.namespace,
    TIER_BUDGET: tierBudget.namespace,
    OWNER_ENFORCEMENT: {
      get: async (key: string, options?: { cacheTtl?: number }) => {
        enforcementCalls.push({
          kind: "get",
          key,
          cacheTtl: options?.cacheTtl,
        });
        return enforcementValues.get(key) ?? null;
      },
      put: async (
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ) => {
        enforcementCalls.push({
          kind: "put",
          key,
          value,
          expirationTtl: options?.expirationTtl,
        });
        enforcementValues.set(key, value);
      },
      delete: async (key: string) => {
        enforcementCalls.push({ kind: "delete", key });
        enforcementValues.delete(key);
      },
    },
    ASN_POLICY: {
      get: async (key: string, options?: { cacheTtl?: number }) => {
        asnPolicyCalls.push({ key, cacheTtl: options?.cacheTtl });
        return asnPolicyValues.get(key) ?? null;
      },
    },
    USAGE_QUEUE: {
      send: async (message: unknown) => {
        usageEvents.push(message);
      },
      sendBatch: async (messages: Iterable<{ body: unknown }>) => {
        for (const message of messages) usageEvents.push(message.body);
      },
    },
    ANON_IP_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limiter.keys.push(key);
        return { success: limiter.success };
      },
    },
    ...overrides,
  };
  return {
    env: env as unknown as Env,
    usageEvents,
    pending,
    limiter,
    ledger,
    ownerLedger,
    ownerGate,
    networkGate,
    tierBudget,
    enforcementValues,
    enforcementCalls,
    asnPolicyValues,
    asnPolicyCalls,
    deps(fetchImpl: typeof fetch, now: () => number = Date.now) {
      return {
        fetch: fetchImpl,
        now,
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      };
    },
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
};

export const fakeExecutionContext = (): ExecutionContext =>
  ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  }) as unknown as ExecutionContext;

export const relayRequest = (
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    cf?: { asn: number; asOrganization?: string };
  } = {},
): Request => {
  const request = new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (options.cf) Object.defineProperty(request, "cf", { value: options.cf });
  return request;
};

export const readError = async (response: Response) =>
  (await response.json()) as {
    error: {
      code: string;
      message: string;
      retryable: boolean;
      upstreamStatus?: number;
      quota?: {
        scope: "capability" | "owner" | "network" | "tier";
        resetAt?: number;
        retryAfterMs?: number;
      };
    };
  };
