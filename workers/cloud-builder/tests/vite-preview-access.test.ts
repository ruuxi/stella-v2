import { describe, expect, test } from "bun:test";
import {
  PREVIEW_ACCESS_MAX_TTL_MS,
  PREVIEW_ACCESS_STORAGE_KEY,
  issuePreviewAccessCapability,
  parsePreviewAccessActiveRecord,
  previewAccessLogFields,
  previewSafeRequestLogPath,
  resolvePreviewTunnelRequest,
  verifyPreviewAccessCapability,
  verifyPreviewAccessRouteCapability,
  type PreviewAccessActiveRecord,
} from "../src/vite-preview-access.js";

const now = 1_800_000_000_000;
const secret = "preview-secret-with-at-least-thirty-two-bytes";
const identity = {
  buildSessionName: "build-session_7.test",
  turnId: "turn-1234",
  sandboxId: "turn-turn-1234",
};
const tunnelUrl = "https://unlogged-preview.trycloudflare.com/";

const issue = (fill = 7) =>
  issuePreviewAccessCapability({
    identity,
    tunnelUrl,
    secret,
    now,
    ttlMs: 60_000,
    randomBytes: (bytes) => bytes.fill(fill),
  });

const verify = async (
  capability: string,
  activeRecord: unknown,
  overrides: Partial<{
    secret: string;
    now: number;
    expected: typeof identity;
  }> = {},
) =>
  await verifyPreviewAccessCapability({
    capability,
    activeRecord,
    secret: overrides.secret ?? secret,
    now: overrides.now ?? now + 1,
    expected: overrides.expected ?? identity,
  });

describe("turn-scoped Vite preview access", () => {
  test("issues a signed capability with no raw tunnel URL in the token or log fields", async () => {
    const { capability, activeRecord } = await issue();
    expect(PREVIEW_ACCESS_STORAGE_KEY).toBe("vite-preview-access:active");
    expect(capability).toMatch(/^pv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(capability).not.toContain("trycloudflare");

    const payload = JSON.parse(
      Buffer.from(capability.split(".")[1]!, "base64url").toString("utf8"),
    );
    expect(payload).toEqual({
      v: 1,
      b: identity.buildSessionName,
      t: identity.turnId,
      s: identity.sandboxId,
      e: now + 60_000,
      n: "BwcHBwcHBwcHBwcHBwcHBw",
    });
    expect(payload).not.toHaveProperty("url");
    expect(payload).not.toHaveProperty("tunnelUrl");
    expect(activeRecord.tunnelUrl).toBe(tunnelUrl);

    const logFields = previewAccessLogFields(activeRecord);
    expect(logFields).toEqual({
      schemaVersion: 1,
      state: "active",
      ...identity,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    expect(JSON.stringify(logFields)).not.toContain("trycloudflare");
    expect(JSON.stringify(logFields)).not.toContain(capability);
  });

  test("verifies through Web Crypto only for the exact active scope", async () => {
    const { capability, activeRecord } = await issue();
    expect(await verify(capability, activeRecord)).toEqual({
      ok: true,
      identity,
      expiresAt: now + 60_000,
      tunnelUrl,
    });

    for (const expected of [
      { ...identity, buildSessionName: "another-session" },
      { ...identity, turnId: "another-turn" },
      { ...identity, sandboxId: "another-sandbox" },
    ]) {
      expect(await verify(capability, activeRecord, { expected })).toEqual({
        ok: false,
        code: "wrong_scope",
      });
    }
    expect(
      await verify(capability, activeRecord, {
        secret: "another-secret-with-at-least-thirty-two-bytes",
      }),
    ).toEqual({ ok: false, code: "bad_signature" });
  });

  test("outer routing accepts only a valid HMAC bound to the named BuildSession", async () => {
    const { capability } = await issue();
    expect(
      await verifyPreviewAccessRouteCapability({
        capability,
        secret,
        expectedBuildSessionName: identity.buildSessionName,
        now: now + 1,
      }),
    ).toEqual({
      ok: true,
      identity,
      expiresAt: now + 60_000,
    });
    expect(
      await verifyPreviewAccessRouteCapability({
        capability,
        secret,
        expectedBuildSessionName: "another-session",
        now: now + 1,
      }),
    ).toEqual({ ok: false, code: "wrong_scope" });
    expect(
      await verifyPreviewAccessRouteCapability({
        capability: `${capability.slice(0, -1)}${capability.endsWith("A") ? "B" : "A"}`,
        secret,
        expectedBuildSessionName: identity.buildSessionName,
        now: now + 1,
      }),
    ).toMatchObject({ ok: false });
  });

  test("keeps proxy paths on the verified tunnel origin and rejects authority tricks", () => {
    expect(
      resolvePreviewTunnelRequest({
        tunnelUrl,
        proxyPathname: "/vite-preview/src/main.tsx",
        search: "?v=1",
      })?.toString(),
    ).toBe(`${tunnelUrl}src/main.tsx?v=1`);
    for (const proxyPathname of [
      "/vite-preview//attacker.invalid/private",
      "/vite-preview/\\attacker.invalid/private",
      "/vite-preview/%2f%2fattacker.invalid/private",
      "/vite-preview/%5c%5cattacker.invalid/private",
      "/wrong-prefix/src/main.tsx",
    ]) {
      expect(
        resolvePreviewTunnelRequest({ tunnelUrl, proxyPathname }),
      ).toBeNull();
    }
  });

  test("redacts the complete signed preview path before request logging", async () => {
    const { capability } = await issue();
    const sensitivePath = `/internal/previews/${identity.buildSessionName}/${capability}/https://unlogged-preview.trycloudflare.com/`;
    const captured = JSON.stringify({
      event: "request_started",
      path: previewSafeRequestLogPath(sensitivePath),
    });
    expect(captured).toBe(
      '{"event":"request_started","path":"/internal/previews/:session/:capability"}',
    );
    expect(captured).not.toContain(capability);
    expect(captured).not.toContain("trycloudflare");
  });

  test("expires at the exact boundary and fails closed without the active record", async () => {
    const { capability, activeRecord } = await issue();
    expect(
      await verify(capability, activeRecord, { now: now + 59_999 }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await verify(capability, activeRecord, { now: now + 60_000 }),
    ).toEqual({
      ok: false,
      code: "expired",
    });
    expect(await verify(capability, null)).toEqual({
      ok: false,
      code: "inactive",
    });
  });

  test("rotating the active nonce revokes the prior capability before expiry", async () => {
    const prior = await issue(7);
    const replacement = await issue(8);
    expect(await verify(prior.capability, replacement.activeRecord)).toEqual({
      ok: false,
      code: "inactive",
    });
    expect(
      await verify(replacement.capability, replacement.activeRecord),
    ).toMatchObject({
      ok: true,
    });
  });

  test("binds every claim with HMAC and rejects any payload or signature edit", async () => {
    const { capability, activeRecord } = await issue();
    const parts = capability.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    for (const changed of [
      { ...payload, b: "forged-session" },
      { ...payload, t: "forged-turn" },
      { ...payload, s: "forged-sandbox" },
      { ...payload, e: payload.e + 1 },
      { ...payload, n: "CQkJCQkJCQkJCQkJCQkJCQ" },
    ]) {
      const edited = `pv1.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${parts[2]}`;
      expect(await verify(edited, activeRecord)).toEqual({
        ok: false,
        code: "bad_signature",
      });
    }
    const first = parts[2]![0]!;
    const alteredFirst = first === "A" ? "B" : "A";
    const editedSignature = `${alteredFirst}${parts[2]!.slice(1)}`;
    expect(
      await verify(`pv1.${parts[1]}.${editedSignature}`, activeRecord),
    ).toEqual({
      ok: false,
      code: "bad_signature",
    });
  });

  test("strictly rejects padded, aliased, truncated, and overlong base64url", async () => {
    const { capability, activeRecord } = await issue();
    const [prefix, payload, signature] = capability.split(".") as [
      string,
      string,
      string,
    ];
    for (const malformed of [
      `${prefix}.${payload}=.${signature}`,
      `${prefix}.${payload}.${signature}=`,
      `${prefix}.${payload}.${signature.slice(1)}`,
      `${prefix}.${payload}.${"A".repeat(44)}`,
      `${prefix}.${payload.slice(0, -2)}*.${signature}`,
      `${prefix}.${"A".repeat(2_049)}.${signature}`,
      `pv2.${payload}.${signature}`,
      `${prefix}.${payload}.${signature}.extra`,
    ]) {
      expect(await verify(malformed, activeRecord)).toEqual({
        ok: false,
        code: "malformed",
      });
    }
  });

  test("parses only an exact bounded active record with a credential-free HTTPS target", async () => {
    const { activeRecord } = await issue();
    expect(
      parsePreviewAccessActiveRecord(structuredClone(activeRecord)),
    ).toEqual(activeRecord);
    const invalidRecords: unknown[] = [
      { ...activeRecord, state: "revoked" },
      { ...activeRecord, extra: true },
      { ...activeRecord, nonce: "not-base64url" },
      { ...activeRecord, buildSessionName: "bad/session" },
      { ...activeRecord, sandboxId: "Bad-Sandbox" },
      { ...activeRecord, turnId: "turn\n2" },
      { ...activeRecord, issuedAt: -1 },
      { ...activeRecord, expiresAt: activeRecord.issuedAt },
      {
        ...activeRecord,
        expiresAt: activeRecord.issuedAt + PREVIEW_ACCESS_MAX_TTL_MS + 1,
      },
      { ...activeRecord, tunnelUrl: "http://preview.example/" },
      { ...activeRecord, tunnelUrl: "https://user:pass@preview.example/" },
      { ...activeRecord, tunnelUrl: "https://preview.example/?token=raw" },
    ];
    for (const invalid of invalidRecords) {
      expect(parsePreviewAccessActiveRecord(invalid)).toBeNull();
    }
  });

  test("rejects weak secrets, unsafe lifetimes, identities, and entropy", async () => {
    await expect(
      issuePreviewAccessCapability({
        identity,
        tunnelUrl,
        secret: "short",
        now,
        ttlMs: 1,
      }),
    ).rejects.toThrow("32-4096 bytes");
    await expect(
      issuePreviewAccessCapability({
        identity,
        tunnelUrl,
        secret,
        now,
        ttlMs: PREVIEW_ACCESS_MAX_TTL_MS + 1,
      }),
    ).rejects.toThrow("bounded window");
    await expect(
      issuePreviewAccessCapability({
        identity: { ...identity, sandboxId: "../../sandbox" },
        tunnelUrl,
        secret,
        now,
        ttlMs: 1,
      }),
    ).rejects.toThrow("bounded identity");
    await expect(
      issuePreviewAccessCapability({
        identity,
        tunnelUrl,
        secret,
        now,
        ttlMs: 1,
        randomBytes: () => new Uint8Array(15),
      }),
    ).rejects.toThrow("wrong length");
  });
});
