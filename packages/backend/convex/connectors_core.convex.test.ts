/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

import {
  resolveRoute,
  canaryBucket,
  composioPathBlocked,
  type ConnectorRollout,
} from "./connectors/routing";
import {
  validateManifest,
  listProviderManifests,
  getProviderManifest,
  requireEnabledProvider,
  scopesForGroups,
  grantedScopesSatisfy,
  pkceChallengeS256,
  generateOAuthState,
} from "./connectors/oauth/providers";
import {
  mergeTokenSet,
  unionScopes,
  expiryFromExpiresIn,
  accessTokenIsFresh,
} from "./connectors/oauth/token_set";
import {
  connectorErrorHttpStatus,
  classifyProviderStatus,
  classifyTokenEndpointError,
  ConnectorError,
} from "./connectors/errors";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|connector-owner";
const otherOwnerId = "https://issuer.test|other-owner";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "connector-owner",
    tokenIdentifier: ownerId,
  });

const MASTER_KEY = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)),
);

const setConnectorEnv = () => {
  process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({ "1": MASTER_KEY });
  process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
  process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK = "1";
  process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "1";
  process.env.STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL = "https://connect.stella.test";
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_ID = "mock-client";
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_SECRETS_JSON = JSON.stringify({
    "1": "mock-secret",
  });
  process.env.STELLA_CONNECTOR_OAUTH_MOCK_CLIENT_SECRET_VERSION = "1";
};

beforeEach(() => {
  setConnectorEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Pure unit: provider manifests + scopes + PKCE
// ---------------------------------------------------------------------------

describe("provider manifests", () => {
  it("every registered manifest is internally consistent", () => {
    for (const manifest of listProviderManifests()) {
      expect(validateManifest(manifest)).toEqual([]);
    }
  });

  it("registers the mock provider only behind the env flag", () => {
    expect(getProviderManifest("mock")).not.toBeNull();
    delete process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK;
    expect(getProviderManifest("mock")).toBeNull();
  });

  it("fails closed for unlisted providers and open for the self-enabling mock", () => {
    expect(() => requireEnabledProvider("google-workspace")).toThrow(/provider_disabled/);
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "google-workspace";
    expect(requireEnabledProvider("google-workspace").key).toBe("google-workspace");
    delete process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS;
    expect(requireEnabledProvider("mock").key).toBe("mock");
  });

  it("unions scope groups and rejects unknown groups", () => {
    const manifest = getProviderManifest("mock")!;
    expect(scopesForGroups(manifest, ["read"]).sort()).toEqual(
      ["mock.profile", "mock.read"].sort(),
    );
    expect(() => scopesForGroups(manifest, ["nope"])).toThrow(/unregistered_scope/);
    expect(() => scopesForGroups(manifest, [])).toThrow(/unregistered_scope/);
  });

  it("computes RFC 7636 S256 challenge and >=32 byte state", async () => {
    // RFC 7636 Appendix B test vector.
    const challenge = await pkceChallengeS256(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(generateOAuthState().length).toBeGreaterThanOrEqual(32);
  });

  it("scope superset check is exact", () => {
    expect(grantedScopesSatisfy(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(grantedScopesSatisfy(["a", "b"], ["a", "c"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: token-set merge rules
// ---------------------------------------------------------------------------

describe("token set merge", () => {
  it("preserves an omitted refresh token and unions scopes", () => {
    const existing = {
      accessToken: "old",
      refreshToken: "refresh-keep",
      tokenType: "Bearer",
      scope: "a b",
    };
    const { tokenSet, grantedScopes } = mergeTokenSet(existing, {
      accessToken: "new",
      scopes: ["b", "c"],
    });
    expect(tokenSet.refreshToken).toBe("refresh-keep");
    expect(tokenSet.accessToken).toBe("new");
    expect(grantedScopes.sort()).toEqual(["a", "b", "c"]);
  });

  it("takes a newly issued refresh token when present", () => {
    const { tokenSet } = mergeTokenSet(
      { accessToken: "o", refreshToken: "r1", tokenType: "Bearer" },
      { accessToken: "n", refreshToken: "r2", scopes: [] },
    );
    expect(tokenSet.refreshToken).toBe("r2");
  });

  it("computes expiry and freshness with skew", () => {
    const now = 1_000_000;
    expect(expiryFromExpiresIn(3600, now)).toBe(now + 3_600_000);
    expect(expiryFromExpiresIn("bad", now)).toBeUndefined();
    expect(accessTokenIsFresh(now + 10 * 60_000, 5 * 60_000, now)).toBe(true);
    expect(accessTokenIsFresh(now + 60_000, 5 * 60_000, now)).toBe(false);
    expect(accessTokenIsFresh(undefined, 5 * 60_000, now)).toBe(false);
    expect(unionScopes(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: routing matrix
// ---------------------------------------------------------------------------

describe("route resolution", () => {
  const rollout = (mode: ConnectorRollout["mode"], extra: Partial<ConnectorRollout> = {}): ConnectorRollout => ({
    connectorId: "c",
    mode,
    routeVersion: 1,
    ...extra,
  });
  const base = { ownerId, operation: "read" as const, killSwitchEnabled: true, hasFirstPartyReady: true };

  it("disabled refuses both executors", () => {
    expect(resolveRoute({ ...base, rollout: rollout("disabled") }).executor).toBe("refused");
  });

  it("kill switch off forces composio, and refuses migrated connectors", () => {
    expect(
      resolveRoute({ ...base, killSwitchEnabled: false, rollout: rollout("first_party_preferred") }).executor,
    ).toBe("composio");
    expect(
      resolveRoute({ ...base, killSwitchEnabled: false, rollout: rollout("first_party_only") }).executor,
    ).toBe("refused");
  });

  it("composio_only and shadow keep composio; shadow flags read-only evaluation", () => {
    expect(resolveRoute({ ...base, rollout: rollout("composio_only") }).executor).toBe("composio");
    const shadow = resolveRoute({ ...base, rollout: rollout("shadow") });
    expect(shadow.executor).toBe("composio");
    expect(shadow.shadowEvaluate).toBe(true);
  });

  it("canary routes selected+ready owners to first-party only", () => {
    const selected = resolveRoute({
      ...base,
      rollout: rollout("first_party_canary", { canaryPercent: 100, saltVersion: 1 }),
    });
    expect(selected.executor).toBe("first_party");
    const notSelected = resolveRoute({
      ...base,
      rollout: rollout("first_party_canary", { canaryPercent: 0 }),
    });
    expect(notSelected.executor).toBe("composio");
    const selectedNotReady = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      rollout: rollout("first_party_canary", { canaryPercent: 100 }),
    });
    expect(selectedNotReady.executor).toBe("composio");
  });

  it("preferred uses first-party when ready, else suggests connect (no silent composio account for writes)", () => {
    expect(
      resolveRoute({ ...base, rollout: rollout("first_party_preferred") }).executor,
    ).toBe("first_party");
    const notReadyRead = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      operation: "read",
      rollout: rollout("first_party_preferred", { allowedFallbacks: ["composio"] }),
    });
    expect(notReadyRead.executor).toBe("composio");
    expect(notReadyRead.firstPartyConnectSuggested).toBe(true);
    expect(notReadyRead.allowReadFallbackToComposio).toBe(true);
    const notReadyWrite = resolveRoute({
      ...base,
      hasFirstPartyReady: false,
      operation: "write",
      rollout: rollout("first_party_preferred", { allowedFallbacks: ["composio"] }),
    });
    // Writes never get an automatic fallback flag.
    expect(notReadyWrite.allowReadFallbackToComposio).toBe(false);
  });

  it("first_party_only routes first-party and blocks the composio path", () => {
    expect(resolveRoute({ ...base, rollout: rollout("first_party_only") }).executor).toBe("first_party");
    expect(composioPathBlocked("first_party_only")).toBe(true);
    expect(composioPathBlocked("disabled")).toBe(true);
    expect(composioPathBlocked("composio_only")).toBe(false);
  });

  it("canary bucketing is deterministic and stable per owner/connector", () => {
    const a = canaryBucket(ownerId, "c", 1);
    const b = canaryBucket(ownerId, "c", 1);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(10000);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: error taxonomy
// ---------------------------------------------------------------------------

describe("error taxonomy", () => {
  it("maps codes to safe HTTP statuses", () => {
    expect(connectorErrorHttpStatus("invalid_input")).toBe(400);
    expect(connectorErrorHttpStatus("reauth_required")).toBe(409);
    expect(connectorErrorHttpStatus("state_replayed")).toBe(410);
    expect(connectorErrorHttpStatus("provider_rate_limited")).toBe(429);
    expect(connectorErrorHttpStatus("provider_unavailable")).toBe(503);
  });

  it("classifies provider status and token-endpoint errors", () => {
    expect(classifyProviderStatus(401).code).toBe("reauth_required");
    expect(classifyProviderStatus(429).retryable).toBe(true);
    expect(classifyProviderStatus(503).code).toBe("provider_unavailable");
    expect(classifyTokenEndpointError("invalid_grant").code).toBe("invalid_grant");
    expect(classifyTokenEndpointError("temporarily_unavailable").retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Convex: connect attempts (state one-time / replay / expiry / owner isolation)
// ---------------------------------------------------------------------------

const createAttempt = async (
  t: ReturnType<typeof createTest>,
  overrides: Partial<{ stateHash: string; expiresAt: number }> = {},
) =>
  await t.mutation(internal.connectors.oauth.attempts.createConnectAttempt, {
    ownerId,
    provider: "mock",
    connectorId: "mockconn",
    scopeGroupIds: ["read"],
    stateHash: overrides.stateHash ?? "state-hash-1",
    encryptedVerifier: "enc",
    keyVersion: 1,
    returnSurface: "desktop",
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  });

describe("connect attempts", () => {
  it("consumes state exactly once and rejects replay", async () => {
    const t = createTest();
    await createAttempt(t, { stateHash: "s1" });
    const first = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s1" },
    );
    expect(first?.ownerId).toBe(ownerId);
    const replay = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s1" },
    );
    expect(replay).toBeNull();
  });

  it("rejects expired state and marks it expired", async () => {
    const t = createTest();
    await createAttempt(t, { stateHash: "s2", expiresAt: Date.now() - 1000 });
    const consumed = await t.mutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash: "s2" },
    );
    expect(consumed).toBeNull();
  });

  it("status polling is owner-isolated", async () => {
    const t = createTest();
    const attemptId = await createAttempt(t, { stateHash: "s3" });
    const own = await asOwner(t).query(
      api.connectors.oauth.attempts.getConnectAttemptStatus,
      { attemptId },
    );
    expect(own?.status).toBe("pending");
    const other = await t
      .withIdentity({
        issuer: "https://issuer.test",
        subject: "other-owner",
        tokenIdentifier: otherOwnerId,
      })
      .query(api.connectors.oauth.attempts.getConnectAttemptStatus, { attemptId });
    expect(other).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Convex: encrypted vault + refresh leasing/generation
// ---------------------------------------------------------------------------

const commitTokens = async (
  t: ReturnType<typeof createTest>,
  incoming: {
    accessToken: string;
    refreshToken?: string;
    scopes: string[];
    accessTokenExpiresAt?: number;
  },
  providerAccountIdIntent?: string,
) =>
  await t.mutation(
    internal.connectors.oauth.vault.commitProviderAccountTokens,
    {
      ownerId,
      provider: "mock",
      providerAccountId: "mock-sub",
      providerAccountIdIntent,
      displayEmail: "u@example.com",
      incoming: {
        accessToken: incoming.accessToken,
        refreshToken: incoming.refreshToken,
        tokenType: "Bearer",
        accessTokenExpiresAt: incoming.accessTokenExpiresAt ?? Date.now() + 3_600_000,
        scopes: incoming.scopes,
      },
    },
  );

describe("encrypted token vault", () => {
  it("upserts account + credential, unions scopes, preserves omitted refresh token", async () => {
    const t = createTest();
    // Hyphenated sentinels: '-' is not in the base64 alphabet, so these strings
    // can never appear inside ciphertext by chance.
    const first = await commitTokens(t, {
      accessToken: "access-first-token",
      refreshToken: "refresh-keep-token",
      scopes: ["mock.profile", "mock.read"],
    });
    // Second incremental grant omits the refresh token and adds a scope.
    const second = await commitTokens(t, {
      accessToken: "access-second-token",
      scopes: ["mock.write"],
    });
    expect(second.accountId).toBe(first.accountId);
    expect(second.grantedScopes.sort()).toEqual(
      ["mock.profile", "mock.read", "mock.write"].sort(),
    );
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId: first.accountId },
    );
    expect(cred?.grantedScopes.sort()).toEqual(
      ["mock.profile", "mock.read", "mock.write"].sort(),
    );
    // Ciphertext is opaque; token payload never leaks in the query result.
    expect(JSON.stringify(cred)).not.toContain("access-second-token");
    expect(JSON.stringify(cred)).not.toContain("refresh-keep-token");
    // The preserved refresh token is still usable after the omitting grant.
    const decrypted = await t.run(async (ctx) => {
      const { decryptSecret } = await import("./data/secrets_crypto");
      const { parseTokenSet } = await import("./connectors/oauth/token_set");
      const row = await ctx.db
        .query("oauth_credentials")
        .withIndex("by_accountId", (q) => q.eq("accountId", first.accountId))
        .unique();
      return parseTokenSet(await decryptSecret(row!.encryptedTokenSet));
    });
    expect(decrypted.refreshToken).toBe("refresh-keep-token");
    expect(decrypted.accessToken).toBe("access-second-token");
  });

  it("rejects an account-mismatch on incremental grant", async () => {
    const t = createTest();
    await commitTokens(t, { accessToken: "a1", refreshToken: "r1", scopes: ["mock.read"] });
    await expect(
      commitTokens(
        t,
        { accessToken: "a2", scopes: ["mock.write"] },
        "different-account",
      ),
    ).rejects.toThrow(/account_mismatch/);
  });

  it("single-flight refresh: second claimant is busy, late commit is rejected", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    const winner = await t.mutation(
      internal.connectors.oauth.vault.claimRefreshLease,
      { accountId, expectedGeneration: 1, leaseId: "lease-A" },
    );
    expect(winner.ok).toBe(true);
    const waiter = await t.mutation(
      internal.connectors.oauth.vault.claimRefreshLease,
      { accountId, expectedGeneration: 1, leaseId: "lease-B" },
    );
    expect(waiter.ok).toBe(false);
    expect(waiter.reason).toBe("busy");

    // A concurrent reconnect bumps the generation and clears the lease.
    await commitTokens(t, { accessToken: "a2", scopes: ["mock.read"] });
    const lateCommit = await t.mutation(
      internal.connectors.oauth.vault.commitRefreshedTokens,
      {
        accountId,
        leaseId: "lease-A",
        expectedGeneration: 1,
        incoming: {
          accessToken: "stale",
          tokenType: "Bearer",
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: ["mock.read"],
        },
      },
    );
    expect(lateCommit.ok).toBe(false);
  });

  it("markAccountReauthRequired tombstones the credential", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    await t.mutation(
      internal.connectors.oauth.vault.markAccountReauthRequired,
      { accountId },
    );
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("reauth_required");
    expect(cred?.encryptedTokenSet).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Convex: scope-aware status, bindings, disconnect
// ---------------------------------------------------------------------------

const bind = async (
  t: ReturnType<typeof createTest>,
  accountId: string,
  requiredScopeGroups: string[],
) =>
  await t.mutation(internal.connectors.oauth.accounts.setConnectorBinding, {
    ownerId,
    connectorId: "mockconn",
    provider: "mock",
    accountId: accountId as never,
    requiredScopeGroups,
  });

describe("scope-aware status and disconnect", () => {
  it("reports missing_scope until granted scopes cover the required groups", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.profile", "mock.read"],
    });
    await bind(t, accountId, ["write"]);
    const before = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(before.connected).toBe(false);
    expect(before.missingScopeGroups).toContain("write");

    await commitTokens(t, { accessToken: "a2", scopes: ["mock.write"] });
    const after = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(after.connected).toBe(true);
    expect(after.status).toBe("connected");
  });

  it("disconnect revokes at provider and destroys ciphertext + bindings", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "a1",
      refreshToken: "r1",
      scopes: ["mock.read"],
    });
    await bind(t, accountId, ["read"]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const result = await asOwner(t).action(
      api.connectors.oauth.accounts.disconnectConnectorAccount,
      { accountId: accountId as never },
    );
    expect(result.revoked).toBe(true);
    expect(result.providerRevoked).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "mock-provider.stella.test/revoke",
    );
    const status = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(status.connected).toBe(false);
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// Convex: rollout admin
// ---------------------------------------------------------------------------

describe("connector rollouts", () => {
  it("bumps routeVersion on each change", async () => {
    const t = createTest();
    const first = await t.mutation(
      internal.connectors.rollouts.setConnectorRollout,
      { connectorId: "mockconn", mode: "shadow" },
    );
    expect(first.routeVersion).toBe(1);
    const second = await t.mutation(
      internal.connectors.rollouts.setConnectorRollout,
      { connectorId: "mockconn", mode: "first_party_only" },
    );
    expect(second.routeVersion).toBe(2);
    const read = await t.query(
      internal.connectors.rollouts.getConnectorRollout,
      { connectorId: "mockconn" },
    );
    expect(read?.mode).toBe("first_party_only");
  });
});

// ---------------------------------------------------------------------------
// Convex: first-party execution pipeline (mock provider)
// ---------------------------------------------------------------------------

const setupConnected = async (
  t: ReturnType<typeof createTest>,
  {
    scopes,
    requiredScopeGroups,
    mode,
    accessTokenExpiresAt,
  }: {
    scopes: string[];
    requiredScopeGroups: string[];
    mode: ConnectorRollout["mode"];
    accessTokenExpiresAt?: number;
  },
) => {
  const { accountId } = await commitTokens(t, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    scopes,
    accessTokenExpiresAt,
  });
  await bind(t, accountId, requiredScopeGroups);
  await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
    connectorId: "mockconn",
    mode,
  });
  return accountId;
};

const runFirstParty = (
  t: ReturnType<typeof createTest>,
  action: string,
  input: Record<string, unknown>,
  schemaJson?: string,
) =>
  t.action(internal.connectors.execute.runFirstPartyConnectorAction, {
    ownerId,
    connectorId: "mockconn",
    action,
    inputJson: JSON.stringify(input),
    schemaJson,
  });

describe("first-party execution", () => {
  it("executes a read against the fixed provider origin with the account token", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ items: [{ id: 1 }] }));

    const result = await runFirstParty(t, "MOCK_READ_ITEMS", {});
    expect(result.output).toEqual({ items: [{ id: 1 }] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mock-provider.stella.test/v1/items");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer access-1",
    );

    // Audit is metadata-only: it records the event but never the token.
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("connector_audit_events")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .collect(),
    );
    expect(events.some((e) => e.event === "execution" && e.outcome === "ok")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("access-1");
  });

  it("validates input against the server schema before calling the provider", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read", "mock.write"],
      requiredScopeGroups: ["write"],
      mode: "first_party_only",
    });
    const schema = JSON.stringify({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "created-1" }));

    await expect(
      runFirstParty(t, "MOCK_CREATE_ITEM", { wrong: true }, schema),
    ).rejects.toThrow(/invalid_input/);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await runFirstParty(t, "MOCK_CREATE_ITEM", { title: "hi" }, schema);
    expect(ok.output).toEqual({ id: "created-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mock-provider.stella.test/v1/items");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "hi" });
  });

  it("refuses to first-party-execute a connector routed to composio", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "composio_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /route_not_first_party/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses on missing scope without contacting the provider", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["write"],
      mode: "first_party_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(runFirstParty(t, "MOCK_CREATE_ITEM", {})).rejects.toThrow(
      /missing_scope/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the global kill switch is off", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    delete process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED;
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /execution_disabled/,
    );
  });

  it("does not fall back or retry a provider error (single request)", async () => {
    const t = createTest();
    await setupConnected(t, {
      scopes: ["mock.profile", "mock.read"],
      requiredScopeGroups: ["read"],
      mode: "first_party_only",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    await expect(runFirstParty(t, "MOCK_READ_ITEMS", {})).rejects.toThrow(
      /provider_unavailable/,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Convex: refresh action (network) with lease + invalid_grant
// ---------------------------------------------------------------------------

describe("access token refresh", () => {
  it("refreshes an expired access token under a lease and bumps generation", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      scopes: ["mock.profile", "mock.read"],
      accessTokenExpiresAt: Date.now() - 1000,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/token")) {
        return jsonResponse({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
          scope: "mock.profile mock.read",
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    const result = await t.action(
      internal.connectors.execute.getAccessTokenForAccount,
      { accountId, requiredScopes: ["mock.profile", "mock.read"] },
    );
    expect(result.accessToken).toBe("new-access");
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.generation).toBe(2);
    expect(cred?.refreshLeaseId).toBeUndefined();
  });

  it("marks the account reauth_required on invalid_grant", async () => {
    const t = createTest();
    const { accountId } = await commitTokens(t, {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      scopes: ["mock.read"],
      accessTokenExpiresAt: Date.now() - 1000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    await expect(
      t.action(internal.connectors.execute.getAccessTokenForAccount, {
        accountId,
        requiredScopes: ["mock.read"],
      }),
    ).rejects.toThrow(/reauth_required/);
    const cred = await t.query(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId },
    );
    expect(cred?.credentialStatus).toBe("reauth_required");
  });
});

// ---------------------------------------------------------------------------
// Convex: hosted callback end-to-end (mock provider)
// ---------------------------------------------------------------------------

describe("hosted OAuth callback", () => {
  it("connects an account end-to-end and rejects state replay", async () => {
    const t = createTest();
    const start = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      { connectorId: "mockconn", provider: "mock", scopeGroupIds: ["read"] },
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(start.authorizationUrl).toContain(
      "mock-provider.stella.test/authorize",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return jsonResponse({
          access_token: "cb-access",
          token_type: "Bearer",
          refresh_token: "cb-refresh",
          expires_in: 3600,
          scope: "mock.profile mock.read",
        });
      }
      if (u.endsWith("/userinfo")) {
        return jsonResponse({ sub: "mock-sub", email: "u@example.com" });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const cb = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "auth-code" },
    );
    expect(cb.status).toBe("succeeded");

    const status = await asOwner(t).query(
      api.connectors.oauth.attempts.getConnectAttemptStatus,
      { attemptId: start.attemptId },
    );
    expect(status?.status).toBe("succeeded");

    const conn = await asOwner(t).query(
      api.connectors.oauth.accounts.getConnectorConnectionStatus,
      { connectorId: "mockconn" },
    );
    expect(conn.connected).toBe(true);
    expect(conn.displayEmail).toBe("u@example.com");

    // Replaying the same state is rejected.
    const replay = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, code: "auth-code" },
    );
    expect(replay.status).toBe("invalid");
  });

  it("records a denied outcome when the provider returns an error", async () => {
    const t = createTest();
    const start = await asOwner(t).mutation(
      api.connectors.oauth.connect.startConnectAttempt,
      { connectorId: "mockconn", provider: "mock", scopeGroupIds: ["read"] },
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const cb = await t.action(
      internal.connectors.oauth.callback.handleOAuthCallback,
      { state, error: "access_denied" },
    );
    expect(cb.status).toBe("denied");
    expect(cb.errorCode).toBe("consent_denied");
  });

  it("rejects an unregistered scope group at connect-start", async () => {
    const t = createTest();
    await expect(
      asOwner(t).mutation(api.connectors.oauth.connect.startConnectAttempt, {
        connectorId: "mockconn",
        provider: "mock",
        scopeGroupIds: ["does-not-exist"],
      }),
    ).rejects.toThrow(/unregistered_scope/);
  });
});

// ---------------------------------------------------------------------------
// Convex: Composio path stays authoritative under rollout
// ---------------------------------------------------------------------------

describe("composio path under rollout", () => {
  const inputSchema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
    additionalProperties: false,
  };

  const publishOutlook = async (t: ReturnType<typeof createTest>) =>
    await t.mutation(internal.data.integrations.upsertPublicIntegration, {
      id: "outlook",
      name: "Outlook",
      provider: "composio",
      category: "email",
      auth: ["OAUTH2"],
      catalogToolCount: 1,
      actions: [
        {
          name: "OUTLOOK_QUERY_EMAILS",
          title: "Query",
          inputSchemaJson: JSON.stringify(inputSchema),
        },
      ],
      description: "Connect Outlook to Stella.",
      connector: { type: "composio", toolkit: "outlook", provider: "composio" },
      enabled: true,
      usagePolicy: "ready",
    });

  it("refuses the composio run path once a connector is first_party_only", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "test-key";
    await publishOutlook(t);
    await t.mutation(internal.connectors.rollouts.setConnectorRollout, {
      connectorId: "outlook",
      mode: "first_party_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await asOwner(t).fetch("/api/native-integrations/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "outlook", action: "OUTLOOK_QUERY_EMAILS", input: { q: "hi" } }),
    });
    expect(response.status).toBe(409);
    // Composio was never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the composio path untouched for connectors without a first-party rollout", async () => {
    const t = createTest();
    process.env.COMPOSIO_API_KEY = "test-key";
    await publishOutlook(t);
    // No rollout row -> default composio_only -> connect-link proceeds to Composio.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "sess_new" }));
    const response = await asOwner(t).fetch("/api/native-integrations/connect-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "outlook" }),
    });
    // Reaches Composio (session creation) rather than being refused by the guard.
    expect(fetchMock).toHaveBeenCalled();
    expect(response.status).not.toBe(409);
  });
});

// Sanity: ConnectorError shape is preserved for downstream mapping.
describe("ConnectorError", () => {
  it("carries a stable code and retryable flag", () => {
    const err = new ConnectorError("provider_rate_limited", true);
    expect(err.code).toBe("provider_rate_limited");
    expect(err.retryable).toBe(true);
  });
});
