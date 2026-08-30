import { describe, expect, test } from "bun:test";
import { AppsAuthService } from "../src/app-auth-service";
import worker from "../src/index";
import { createEnv, TEST_APP_TOKEN_SIGNING_KEY } from "./fixtures";

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encrypt = async (payload: Record<string, unknown>): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(TEST_APP_TOKEN_SIGNING_KEY),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `v2.${base64url(nonce)}.${base64url(new Uint8Array(ciphertext))}`;
};

const service = (): AppsAuthService => {
  const instance = Object.create(AppsAuthService.prototype) as AppsAuthService;
  Object.defineProperty(instance, "env", { value: createEnv() });
  return instance;
};

const request = (now: number) => ({
  origin: "null",
  method: "POST",
  targetOrigin: "https://api.example.com",
  targetUrl: "https://api.example.com/items",
  requestHash: "a".repeat(64),
  now,
});

const payload = (now: number) => ({
  version: 1,
  audience: "stella-app-fetch-v1",
  issuer: "dev:outgoing-bulldog-865",
  tokenId: "00000000-0000-4000-8000-000000000002",
  appId: "app-a",
  viewerNamespace: "viewer-a",
  ...request(now),
  issuedAt: now,
  exp: now + 60_000,
});

describe("trusted fetch-capability authority", () => {
  test("binds connected-session minting to the server-issued app bootstrap", async () => {
    const authority = service();
    const { bootstrap } = await authority.mintAppBootstrap({
      appId: "app-a",
      slug: "app-a-slug",
      origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
    });
    const originalFetch = globalThis.fetch;
    let forwardedAppId = "";
    try {
      globalThis.fetch = (async (_input, init) => {
        forwardedAppId = JSON.parse(String(init?.body)).appId;
        return Response.json({ token: "scoped-app-session", expiresAt: Date.now() + 60_000 });
      }) as typeof fetch;
      const response = await worker.fetch(
        new Request(
          "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev/api/apps/connected-session",
          {
            method: "POST",
            headers: {
              origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
              "sec-fetch-site": "same-site",
              "sec-fetch-mode": "cors",
              cookie: "__Host-stella_account_session=signed-session.signature",
              "content-type": "application/json",
            },
            body: JSON.stringify({ bootstrap, appId: "app-b" }),
          },
        ),
        createEnv(),
      );
      expect(response.status).toBe(200);
      expect(forwardedAppId).toBe("app-a");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts an exact opaque, request-bound capability", async () => {
    const now = Date.now();
    const capability = await encrypt(payload(now));
    expect(capability).not.toContain("app-a");
    expect(
      await service().verifyFetchCapability({
        capability,
        ...request(now),
      }),
    ).toMatchObject({
      ok: true,
      appId: "app-a",
      viewerNamespace: "viewer-a",
    });
  });

  test.each([
    ["other viewer request", { requestHash: "b".repeat(64) }],
    ["other target", { targetUrl: "https://api.example.com/other" }],
    ["other method", { method: "DELETE" }],
    ["other origin", { origin: "https://attacker.example" }],
  ])("rejects %s against the same capability", async (_label, override) => {
    const now = Date.now();
    const capability = await encrypt(payload(now));
    expect(
      await service().verifyFetchCapability({
        capability,
        ...request(now),
        ...override,
      }),
    ).toMatchObject({ ok: false });
  });

  test("rejects expiry and lifetime extension", async () => {
    const now = Date.now();
    const expired = await encrypt({ ...payload(now), exp: now - 1 });
    const overlong = await encrypt({ ...payload(now), exp: now + 91_000 });
    expect(
      await service().verifyFetchCapability({
        capability: expired,
        ...request(now),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await service().verifyFetchCapability({
        capability: overlong,
        ...request(now),
      }),
    ).toMatchObject({ ok: false });
  });
});
