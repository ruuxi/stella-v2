import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  connectPreregisteredConnectorOAuth,
  loadConnectorAccessToken,
  loadConnectorTokenPayload,
  saveConnectorTokenPayload,
} from "@stella/runtime/kernel/connectors/oauth";
import { getNativeConnectorCatalogEntry } from "@stella/runtime/kernel/connectors/native-integrations";
import {
  getNativeConnectorReadiness,
  nativeConnectorAuthStatus,
} from "@stella/runtime/kernel/connectors/connection-status";
import {
  IDENTITY_SCOPES,
  SCOPES,
} from "@stella/runtime/kernel/google-workspace/scopes";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

/**
 * End-to-end verification of the shared Google Workspace grant. Every current
 * connect requests the complete six-service union; incremental consent exists
 * only to upgrade older partial grants without losing their refresh token.
 *
 * This drives the real `connectPreregisteredConnectorOAuth` credential flow
 * against a local loopback OAuth server that faithfully mimics Google's
 * behaviour:
 *   - a single grant / token key ("google-workspace") backs every service;
 *   - Google omits refresh_token on later incremental consents;
 *   - the granted `scope` returned by the token endpoint drives the union;
 *   - the authorization URL always requests the canonical complete union.
 *
 * It proves: scope-aware status (connected vs scope_upgrade_required vs
 * not_logged_in), incremental scope UNION, refresh-token PRESERVATION across
 * an incremental consent, shared identity, and encryption-at-rest.
 */

const TOKEN_KEY = "google-workspace";
const IDENTITY = [...IDENTITY_SCOPES];
const LEGACY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const ACCESS_1 = "gw-access-token-CONSENT-1";
const ACCESS_2 = "gw-access-token-CONSENT-2";
const REFRESH_1 = "gw-refresh-token-FIRST-CONSENT-ONLY";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  scope: string;
  expires_in: number;
};

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-gw-e2e-"));
  roots.push(root);
  return root;
};

const entry = (id: string) => getNativeConnectorCatalogEntry(id)!;

// --- Local OAuth token endpoint that mimics Google -------------------------
let tokenServer: http.Server;
let tokenEndpoint: string;
let nextTokenResponse: TokenResponse | null = null;
const tokenRequests: Array<Record<string, string>> = [];

beforeAll(async () => {
  tokenServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(nextTokenResponse));
    });
  });
  await new Promise<void>((resolve) =>
    tokenServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = tokenServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  tokenEndpoint = `http://127.0.0.1:${port}/token`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
});

beforeEach(() => {
  installTestSafeStorage();
  tokenRequests.length = 0;
});

afterEach(async () => {
  resetTestSafeStorage();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Simulates the user completing consent in the browser: parse the
 * authorization URL, then hit the local loopback redirect with a code so the
 * flow's callback listener resolves.
 */
const consent = async (
  root: string,
  requestedScopes: string[],
  granted: TokenResponse,
  inspectAuthorizationUrl?: (url: URL) => void,
) => {
  nextTokenResponse = granted;
  return connectPreregisteredConnectorOAuth(root, {
    tokenKey: TOKEN_KEY,
    clientId: "gw-desktop-client.apps.googleusercontent.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint,
    scopes: requestedScopes,
    authorizationParams: { include_granted_scopes: "true" },
    openUrl: async (url) => {
      const authUrl = new URL(url);
      inspectAuthorizationUrl?.(authUrl);
      const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "auth-code-xyz");
      redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
      await new Promise<void>((resolve, reject) => {
        http
          .get(redirect.toString(), (res) => {
            res.resume();
            res.on("end", () => resolve());
          })
          .on("error", reject);
      });
    },
  });
};

describe("google-workspace shared-bundle incremental scope upgrade (e2e)", () => {
  it("upgrades a partial legacy grant to the complete union while preserving its refresh token", async () => {
    const root = makeRoot();

    // Simulate a historical grant issued before the complete shared bundle.
    await saveConnectorTokenPayload(root, TOKEN_KEY, {
      accessToken: ACCESS_1,
      refreshToken: REFRESH_1,
      scopes: [...IDENTITY, LEGACY_SCOPE],
    });

    const afterFirst = await loadConnectorTokenPayload(root, TOKEN_KEY);
    expect(afterFirst?.accessToken).toBe(ACCESS_1);
    expect(afterFirst?.refreshToken).toBe(REFRESH_1);
    expect(new Set(afterFirst?.scopes)).toEqual(
      new Set([...IDENTITY, LEGACY_SCOPE]),
    );

    // The account is linked, but only its legacy Gmail surface is ready.
    expect(await nativeConnectorAuthStatus(root, entry("gmail"))).toBe(
      "connected",
    );
    expect(await nativeConnectorAuthStatus(root, entry("googletasks"))).toBe(
      "scope_upgrade_required",
    );

    // Encryption-at-rest: the on-disk credential store must be protected and
    // must NOT contain the plaintext access or refresh token.
    const credPath = path.join(root, "connectors", ".credentials.json");
    const raw = readFileSync(credPath, "utf8");
    expect(raw).toContain("stella-protected");
    expect(raw).not.toContain(ACCESS_1);
    expect(raw).not.toContain(REFRESH_1);

    // Current connects request the complete shared union. Google returns no
    // refresh_token during incremental consent, so preserve the legacy one.
    let authorizationUrl: URL | undefined;
    await consent(
      root,
      SCOPES,
      {
        access_token: ACCESS_2,
        scope: SCOPES.join(" "),
        expires_in: 3600,
      },
      (url) => {
        authorizationUrl = url;
      },
    );

    const afterSecond = await loadConnectorTokenPayload(root, TOKEN_KEY);
    expect(afterSecond?.accessToken).toBe(ACCESS_2);
    expect(afterSecond?.refreshToken).toBe(REFRESH_1);
    expect(afterSecond?.scopes).toEqual(SCOPES);

    for (const id of ["gmail", "googletasks", "googlesuper"]) {
      expect(await nativeConnectorAuthStatus(root, entry(id))).toBe(
        "connected",
      );
    }

    // Representative services are executable from the same shared grant.
    for (const id of ["googletasks", "gmail"]) {
      const readiness = await getNativeConnectorReadiness(root, entry(id));
      expect(readiness.accountVerified).toBe(true);
      expect(readiness.authStatus).toBe("connected");
    }
    expect(await loadConnectorAccessToken(root, TOKEN_KEY)).toBe(ACCESS_2);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].grant_type).toBe("authorization_code");
    expect(tokenRequests[0].code_verifier).toBeTruthy();
    expect(authorizationUrl).toBeDefined();
    expect(authorizationUrl!.searchParams.get("scope")?.split(" ")).toEqual(
      SCOPES,
    );
    expect(authorizationUrl!.searchParams.get("include_granted_scopes")).toBe(
      "true",
    );
    expect(authorizationUrl!.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  it("completing the full six-service union flips the bundle to connected", async () => {
    const root = makeRoot();
    await consent(root, SCOPES, {
      access_token: ACCESS_1,
      refresh_token: REFRESH_1,
      scope: SCOPES.join(" "),
      expires_in: 3600,
    });
    expect(await nativeConnectorAuthStatus(root, entry("googlesuper"))).toBe(
      "connected",
    );
  });
});
