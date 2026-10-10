/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  assertHostedConnectRequestUrl,
  isHostedConnectOriginAllowed,
  isUnsafeIpv4,
  isUnsafeIpv6,
  normalizeHostedConnectOrigin,
} from "./connectors/hosted_connect/origin";
import {
  buildAuthenticatedHostedConnectRequest,
  executeHostedConnectAction,
  redactHostedConnectToken,
} from "./connectors/hosted_connect/execute";
import {
  getHostedConnectProviderDescriptor,
  HOSTED_CONNECT_PROVIDER_DESCRIPTORS,
  isHostedConnectProviderVerified,
  validateHostedConnectProviderDescriptors,
  validateHostedConnectToken,
} from "./connectors/hosted_connect/providers";
import { DEFERRED_API_KEY_PROVIDERS } from "./connectors/executors/api_key";
import {
  isHostedConnectEgressTransportAvailable,
  requireHostedConnectEgressTransport,
  setHostedConnectEgressTransportForTesting,
  type HostedConnectEgressTransport,
} from "./connectors/hosted_connect/transport";
import {
  firstPartyActionOperation,
  firstPartyProviderForConnector,
  firstPartyProviderForConnectorAction,
} from "./connectors/executors/first_party";
import { ConnectorError } from "./connectors/errors";
import { isProviderEnabled } from "./connectors/env";
import { decryptSecret } from "./data/secrets_crypto";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|hosted-owner";
const otherOwnerId = "https://issuer.test|other-hosted-owner";

// Valid-shape 1Password Connect access token (JWT: header.payload.signature).
const CONNECT_TOKEN =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiIxcGFzc3dvcmQtY29ubmVjdCJ9.sig-Value_Segment-abc123DEF456ghi789";
const CONNECT_TOKEN_2 =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6Inh5eiJ9.eyJzdWIiOiJyb3RhdGVkIn0.other-Signature_Segment-zzz999YYY888";
const BOUND_ORIGIN = "https://connect.acme-corp.com";

const MASTER_KEY = btoa(
  String.fromCharCode(
    ...Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff),
  ),
);

const createTest = () => {
  const test = convexTest(schema, modules);
  registerRateLimiter(test);
  return test;
};

const asOwner = (test: ReturnType<typeof createTest>) =>
  test.withIdentity({
    issuer: "https://issuer.test",
    subject: "hosted-owner",
    tokenIdentifier: ownerId,
  });

const asOtherOwner = (test: ReturnType<typeof createTest>) =>
  test.withIdentity({
    issuer: "https://issuer.test",
    subject: "other-hosted-owner",
    tokenIdentifier: otherOwnerId,
  });

const setEnv = () => {
  process.env.STELLA_SECRETS_MASTER_KEYS_JSON = JSON.stringify({
    "1": MASTER_KEY,
  });
  process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "1";
  process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "1";
  process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "1password";
  process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS = "1password";
  // The mock escape hatch is what allows a *simulated* egress transport to be
  // injected in tests. Production never sets this, so no transport is ever
  // resolved there. See transport.ts.
  process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK = "1";
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connect = (
  test: ReturnType<typeof createTest>,
  origin = BOUND_ORIGIN,
  token = CONNECT_TOKEN,
  expectedGeneration?: number,
) =>
  asOwner(test).action(
    api.connectors.hosted_connect.vault.connectHostedConnectProfile,
    { connectorId: "1password", origin, token, expectedGeneration },
  );

const enableFirstParty = async (test: ReturnType<typeof createTest>) => {
  await test.mutation(internal.connectors.rollouts.setConnectorRollout, {
    connectorId: "1password",
    mode: "first_party_only",
  });
};

const run = (
  test: ReturnType<typeof createTest>,
  action: string,
  input: Record<string, unknown>,
) =>
  test.action(internal.connectors.execute.runFirstPartyConnectorAction, {
    ownerId,
    connectorId: "1password",
    action,
    inputJson: JSON.stringify(input),
  });

// A simulated egress transport that forwards to the (mocked) global fetch,
// standing in for the future DNS-pinning/allowlisting proxy. It is armed only
// because setEnv sets the mock escape hatch; production resolves no transport.
const TEST_TRANSPORT: HostedConnectEgressTransport = {
  kind: "test-proxy",
  dispatch: (url, init) => fetch(url, init),
};

// Remove the simulated transport for a single test to reproduce production
// (direct-fetch-only) reality, where every path must fail closed.
const withoutEgressTransport = () =>
  setHostedConnectEgressTransportForTesting(null);

beforeEach(() => {
  setEnv();
  setHostedConnectEgressTransportForTesting(TEST_TRANSPORT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setHostedConnectEgressTransportForTesting(null);
});

describe("hosted-connect origin validation (SSRF)", () => {
  it("accepts only exact public HTTPS origins", () => {
    for (const origin of [
      "https://connect.example.com",
      "https://connect.example.com/",
      "https://connect.example.com:8443",
      "https://1password.acme.co.uk",
      "https://8.8.8.8",
      "https://[2606:4700:4700::1111]",
    ]) {
      expect(isHostedConnectOriginAllowed(origin), origin).toBe(true);
    }
  });

  it("rejects credentials, path, query, fragment and non-https", () => {
    for (const origin of [
      "http://connect.example.com",
      "https://user:pass@connect.example.com",
      "https://connect.example.com/v1",
      "https://connect.example.com?x=1",
      "https://connect.example.com#frag",
      "ftp://connect.example.com",
      "connect.example.com",
      "",
    ]) {
      expect(isHostedConnectOriginAllowed(origin), origin).toBe(false);
      expect(() => normalizeHostedConnectOrigin(origin)).toThrow(
        ConnectorError,
      );
    }
  });

  it("rejects loopback / private / link-local / reserved hosts", () => {
    for (const origin of [
      "https://localhost",
      "https://myserver",
      "https://connect.local",
      "https://foo.internal",
      "https://foo.test",
      "https://a.invalid",
      "https://10.0.0.1",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://192.168.1.10",
      "https://172.16.5.4",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://255.255.255.255",
      "https://224.0.0.1",
      "https://198.51.100.7",
      "https://203.0.113.9",
      "https://[::1]",
      "https://[fe80::1]",
      "https://[fc00::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[64:ff9b::7f00:1]",
    ]) {
      expect(isHostedConnectOriginAllowed(origin), origin).toBe(false);
    }
  });

  it("rejects known public DNS-rebinding wildcard hosts", () => {
    for (const origin of [
      "https://127.0.0.1.nip.io",
      "https://10.0.0.1.sslip.io",
      "https://anything.xip.io",
    ]) {
      expect(isHostedConnectOriginAllowed(origin), origin).toBe(false);
    }
  });

  it("canonicalizes host casing and default ports", () => {
    expect(normalizeHostedConnectOrigin("https://Connect.Example.COM")).toBe(
      "https://connect.example.com",
    );
    expect(
      normalizeHostedConnectOrigin("https://connect.example.com:443"),
    ).toBe("https://connect.example.com");
    expect(
      normalizeHostedConnectOrigin("https://connect.example.com:8443"),
    ).toBe("https://connect.example.com:8443");
  });

  it("classifies unsafe IP ranges", () => {
    expect(isUnsafeIpv4([127, 0, 0, 1])).toBe(true);
    expect(isUnsafeIpv4([169, 254, 0, 1])).toBe(true);
    expect(isUnsafeIpv4([8, 8, 8, 8])).toBe(false);
    expect(isUnsafeIpv6([0, 0, 0, 0, 0, 0, 0, 1])).toBe(true); // ::1
    expect(isUnsafeIpv6([0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111])).toBe(
      false,
    );
  });

  it("builds a fixed path bound to the exact origin and rejects escapes", () => {
    const url = assertHostedConnectRequestUrl(BOUND_ORIGIN, "/v1/vaults");
    expect(url.toString()).toBe("https://connect.acme-corp.com/v1/vaults");
    for (const path of ["//evil.com/x", "/v1/a\r\nb", "no-leading-slash"]) {
      expect(() => assertHostedConnectRequestUrl(BOUND_ORIGIN, path)).toThrow(
        ConnectorError,
      );
    }
    // A stored origin that no longer validates can never be executed against.
    expect(() =>
      assertHostedConnectRequestUrl("https://127.0.0.1", "/v1/vaults"),
    ).toThrow(ConnectorError);
  });

  it("rejects dot-segment path traversal before URL resolution", () => {
    for (const path of [
      "/v1/vaults/../items",
      "/v1/vaults/./items",
      "/../etc/passwd",
      "/v1/vaults/..",
      "/.",
    ]) {
      expect(() => assertHostedConnectRequestUrl(BOUND_ORIGIN, path)).toThrow(
        ConnectorError,
      );
    }
    // The planner emits `..` as an encoded id, which must be rejected too.
    expect(() =>
      assertHostedConnectRequestUrl(
        BOUND_ORIGIN,
        `/v1/vaults/${encodeURIComponent("..")}/items`,
      ),
    ).toThrow(ConnectorError);
  });
});

describe("hosted-connect egress transport gate (fail closed)", () => {
  it("resolves no egress transport in a production-like env", () => {
    withoutEgressTransport();
    delete process.env.STELLA_CONNECTOR_OAUTH_ALLOW_MOCK;
    expect(isHostedConnectEgressTransportAvailable()).toBe(false);
    expect(() => requireHostedConnectEgressTransport()).toThrow(
      /egress_transport_unavailable/,
    );
    // The test seam refuses to arm without the mock escape hatch, so no env
    // combination can enable a transport in production.
    expect(() =>
      setHostedConnectEgressTransportForTesting({
        kind: "x",
        dispatch: async () => new Response(),
      }),
    ).toThrow();
  });

  it("connect fails closed and stores no token without a transport", async () => {
    withoutEgressTransport();
    const test = createTest();
    await expect(connect(test)).rejects.toThrow(/egress_transport_unavailable/);
    const rows = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("execution fails closed with no fetch when the transport is removed", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test); // profile stored while a transport is simulated
    withoutEgressTransport(); // now reproduce production (direct-fetch-only)
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /egress_transport_unavailable/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("status is never ready and reports egressTransportReady=false", async () => {
    const test = createTest();
    await connect(test);
    withoutEgressTransport();
    const status = await asOwner(test).query(
      api.connectors.hosted_connect.vault.getHostedConnectStatus,
      { connectorId: "1password" },
    );
    expect(status.connected).toBe(true);
    expect(status.providerEnabled).toBe(true);
    expect(status.providerVerified).toBe(true);
    expect(status.egressTransportReady).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("executeHostedConnectAction refuses to egress without a transport", async () => {
    withoutEgressTransport();
    const descriptor = getHostedConnectProviderDescriptor("1password")!;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      executeHostedConnectAction({
        descriptor,
        token: CONNECT_TOKEN,
        boundOrigin: BOUND_ORIGIN,
        action: "ONEPASSWORD_LIST_VAULTS",
        input: {},
        operation: "read",
      }),
    ).rejects.toThrow(/egress_transport_unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hosted-connect provider catalog", () => {
  it("has no structural problems and matches the planner catalog", () => {
    expect(validateHostedConnectProviderDescriptors()).toEqual([]);
    const onePassword = getHostedConnectProviderDescriptor("1password");
    expect(onePassword?.providerKey).toBe("1password");
    const deferred = DEFERRED_API_KEY_PROVIDERS.find(
      (provider) => provider.connectorId === "1password",
    );
    expect(deferred?.requiresTenantOrigin).toBe(true);
    expect(deferred?.fixedApiOrigin).toBeUndefined();
    expect(deferred?.tenantOriginSuffix).toBeUndefined();
  });

  it("keeps enablement and representative verification independent", () => {
    for (const descriptor of HOSTED_CONNECT_PROVIDER_DESCRIPTORS) {
      process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS =
        descriptor.providerKey;
      process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS = "";
      expect(isProviderEnabled(descriptor.providerKey)).toBe(true);
      expect(isHostedConnectProviderVerified(descriptor.providerKey)).toBe(
        false,
      );
      process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "";
      process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS =
        descriptor.providerKey;
      expect(isProviderEnabled(descriptor.providerKey)).toBe(false);
      expect(isHostedConnectProviderVerified(descriptor.providerKey)).toBe(
        true,
      );
    }
  });

  it("validates Connect token shape (JWT only)", () => {
    expect(validateHostedConnectToken(CONNECT_TOKEN)).toBe(CONNECT_TOKEN);
    for (const bad of [
      "",
      "short",
      "not-a-jwt",
      "only.two",
      `${CONNECT_TOKEN} `,
      "has spaces.in.token",
      42 as unknown as string,
    ]) {
      expect(() => validateHostedConnectToken(bad)).toThrow(ConnectorError);
    }
  });
});

describe("hosted-connect first-party routing helpers", () => {
  it("resolves 1password as a first-party hosted-connect provider", () => {
    expect(firstPartyProviderForConnector("1password")).toBe("1password");
    expect(
      firstPartyProviderForConnectorAction(
        "1password",
        "ONEPASSWORD_LIST_VAULTS",
      ),
    ).toBe("1password");
    expect(
      firstPartyActionOperation("1password", "ONEPASSWORD_LIST_VAULTS"),
    ).toBe("read");
    expect(
      firstPartyActionOperation("1password", "ONEPASSWORD_CREATE_ITEM"),
    ).toBe("write");
    expect(
      firstPartyProviderForConnectorAction("1password", "NOT_AN_ACTION"),
    ).toBeNull();
  });
});

describe("hosted-connect vault lifecycle", () => {
  it("encrypts the token, binds the origin, and never returns ciphertext plaintext", async () => {
    const test = createTest();
    const result = await connect(test);
    expect(result).toMatchObject({
      connected: true,
      provider: "1password",
      boundOrigin: BOUND_ORIGIN,
      generation: 1,
      replaced: false,
    });
    const rows = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").collect(),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ownerId).toBe(ownerId);
    expect(row.boundOrigin).toBe(BOUND_ORIGIN);
    expect(row.encryptedToken).not.toContain(CONNECT_TOKEN);
    expect(JSON.parse(row.encryptedToken)).toMatchObject({
      keyVersion: 1,
      dataCiphertext: expect.any(String),
    });
    expect(await decryptSecret(row.encryptedToken)).toBe(CONNECT_TOKEN);
  });

  it("surfaces bound origin in status but only to the owner", async () => {
    const test = createTest();
    await connect(test);
    const ownerStatus = await asOwner(test).query(
      api.connectors.hosted_connect.vault.getHostedConnectStatus,
      { connectorId: "1password" },
    );
    expect(ownerStatus).toMatchObject({
      connected: true,
      boundOrigin: BOUND_ORIGIN,
      ready: true,
      authType: "hosted_connect",
    });
    const otherStatus = await asOtherOwner(test).query(
      api.connectors.hosted_connect.vault.getHostedConnectStatus,
      { connectorId: "1password" },
    );
    expect(otherStatus).toMatchObject({
      connected: false,
      configured: false,
    });
    expect(otherStatus.boundOrigin).toBeUndefined();
  });

  it("replaces token+origin under an optimistic generation guard", async () => {
    const test = createTest();
    await connect(test);
    await expect(connect(test, BOUND_ORIGIN, CONNECT_TOKEN_2)).rejects.toThrow(
      /credential_generation_conflict/,
    );
    const replaced = await connect(
      test,
      "https://connect2.acme-corp.com",
      CONNECT_TOKEN_2,
      1,
    );
    expect(replaced).toMatchObject({
      replaced: true,
      generation: 2,
      boundOrigin: "https://connect2.acme-corp.com",
    });
    const row = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").first(),
    );
    expect(row?.boundOrigin).toBe("https://connect2.acme-corp.com");
    expect(await decryptSecret(row!.encryptedToken)).toBe(CONNECT_TOKEN_2);
  });

  it("rejects malicious origins and malformed tokens at connect time", async () => {
    const test = createTest();
    await expect(connect(test, "https://127.0.0.1")).rejects.toThrow(
      /invalid_origin/,
    );
    await expect(
      connect(test, "https://connect.acme-corp.com/v1"),
    ).rejects.toThrow(/invalid_origin/);
    await expect(connect(test, BOUND_ORIGIN, "not-a-jwt")).rejects.toThrow(
      /invalid_credential/,
    );
    const rows = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("disconnects and isolates owners", async () => {
    const test = createTest();
    await connect(test);
    const disconnected = await asOwner(test).action(
      api.connectors.hosted_connect.vault.disconnectHostedConnectProfile,
      { connectorId: "1password" },
    );
    expect(disconnected).toEqual({ connected: false, disconnected: true });
    const rows = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("requires verification and enablement before connecting", async () => {
    const test = createTest();
    process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS = "";
    await expect(connect(test)).rejects.toThrow(/provider_unverified/);
    process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS =
      "1password";
    process.env.STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS = "";
    await expect(connect(test)).rejects.toThrow(/provider_disabled/);
  });
});

describe("hosted-connect execution and egress controls", () => {
  it("sends the bearer token only to the bound origin at a fixed path", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ items: [] }));
    const result = await run(test, "ONEPASSWORD_LIST_ITEMS", {
      vaultUuid: "vault-1",
    });
    expect(result.executor).toBe("first_party");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://connect.acme-corp.com/v1/vaults/vault-1/items",
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CONNECT_TOKEN}`);
  });

  it("never follows redirects and returns a classified error", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://10.0.0.1/" },
      }),
    );
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /provider_unavailable/,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("executes exactly one request with no write retry", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }, 500));
    await expect(
      run(test, "ONEPASSWORD_CREATE_ITEM", {
        vaultUuid: "vault-1",
        category: "LOGIN",
        title: "Example",
      }),
    ).rejects.toThrow(/ambiguous_write/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts the token from any provider output", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        echoed: CONNECT_TOKEN,
        nested: { t: `Bearer ${CONNECT_TOKEN}` },
      }),
    );
    const result = await run(test, "ONEPASSWORD_LIST_VAULTS", {});
    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toContain(CONNECT_TOKEN);
    expect(serialized).toContain("[REDACTED]");
  });

  it("invalidates the stored token on a 401 and refuses to re-run", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "unauthorized" }, 401),
    );
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /invalid_credential/,
    );
    const row = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").first(),
    );
    expect(row?.status).toBe("invalid");
    expect(row?.encryptedToken).toBe("");
  });

  it("re-validates a tampered stored origin before any fetch", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    // Simulate a stored profile whose origin no longer passes SSRF validation.
    await test.run(async (ctx) => {
      const row = await ctx.db.query("connector_hosted_profiles").first();
      if (row)
        await ctx.db.patch(row._id, { boundOrigin: "https://127.0.0.1" });
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /invalid_origin/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing input fields before dispatch", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      run(test, "ONEPASSWORD_CREATE_ITEM", {
        vaultUuid: "vault-1",
        category: "LOGIN",
        title: "Example",
        token: "should-not-be-here",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hosted-connect activation gates", () => {
  it("does not run when first-party execution is disabled", async () => {
    const test = createTest();
    await enableFirstParty(test);
    await connect(test);
    process.env.STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED = "";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /execution_disabled/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not run when the provider is not verified or not connected", async () => {
    const test = createTest();
    await enableFirstParty(test);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // Enabled + verified but no stored profile.
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /not_connected/,
    );
    await connect(test);
    process.env.STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS = "";
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /provider_unverified/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not run first-party when the rollout keeps Composio", async () => {
    const test = createTest();
    // No rollout row => composio_only default.
    await connect(test);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(run(test, "ONEPASSWORD_LIST_VAULTS", {})).rejects.toThrow(
      /route_not_first_party/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hosted-connect request builder units", () => {
  it("places the bearer token and forbids unsafe forwarded headers", () => {
    const descriptor = getHostedConnectProviderDescriptor("1password")!;
    const { url, init } = buildAuthenticatedHostedConnectRequest({
      descriptor,
      token: CONNECT_TOKEN,
      boundOrigin: BOUND_ORIGIN,
      request: { method: "GET", path: "/v1/vaults" },
    });
    expect(url).toBe("https://connect.acme-corp.com/v1/vaults");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${CONNECT_TOKEN}`,
    );
    expect(() =>
      buildAuthenticatedHostedConnectRequest({
        descriptor,
        token: CONNECT_TOKEN,
        boundOrigin: BOUND_ORIGIN,
        request: {
          method: "GET",
          path: "/v1/vaults",
          headers: { "x-evil": "1" },
        },
      }),
    ).toThrow(ConnectorError);
  });

  it("redacts raw and bearer forms of the token", () => {
    const redacted = redactHostedConnectToken(
      { a: CONNECT_TOKEN, b: `Bearer ${CONNECT_TOKEN}`, c: "safe" },
      CONNECT_TOKEN,
    );
    expect(JSON.stringify(redacted)).not.toContain(CONNECT_TOKEN);
    expect((redacted as { c: string }).c).toBe("safe");
  });

  it("executes exactly one fetch on success", async () => {
    const descriptor = getHostedConnectProviderDescriptor("1password")!;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }));
    const result = await executeHostedConnectAction({
      descriptor,
      token: CONNECT_TOKEN,
      boundOrigin: BOUND_ORIGIN,
      action: "ONEPASSWORD_LIST_VAULTS",
      input: {},
      operation: "read",
    });
    expect(result.providerStatusClass).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("hosted-connect account deletion", () => {
  it("purges the owner's hosted profile", async () => {
    const test = createTest();
    await connect(test);
    await test.action(internal.account_deletion.purgeOwnerCloudData, {
      ownerId,
    });
    const rows = await test.run(async (ctx) =>
      ctx.db.query("connector_hosted_profiles").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
