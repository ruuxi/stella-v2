import { WorkerEntrypoint } from "cloudflare:workers";
import {
  readAppsHostConfig,
  type AppsHostConfig,
  type AppsHostTrustedEnv,
} from "./config";
import { readBoundedBytes } from "./http-security";

const APP_FETCH_AUDIENCE = "stella-app-fetch-v1";
const APP_BOOTSTRAP_AUDIENCE = "stella-app-bootstrap-v1";
const APP_BOOTSTRAP_TTL_MS = 2 * 60_000;
const MAX_SESSION_RESPONSE_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const base64urlBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
  const padding = (4 - (value.length % 4)) % 4;
  return Uint8Array.from(
    atob(
      `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(padding)}`,
    ),
    (char) => char.charCodeAt(0),
  );
};

const decryptCapability = async (
  raw: string,
  secret: string,
): Promise<Record<string, unknown>> => {
  if (raw.length < 32 || raw.length > 8_192) throw new Error("invalid token");
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v2" || !parts[1] || !parts[2]) {
    throw new Error("invalid token");
  }
  const nonce = base64urlBytes(parts[1]);
  if (nonce.byteLength !== 12) throw new Error("invalid token");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    key,
    base64urlBytes(parts[2]) as unknown as BufferSource,
  );
  const parsed: unknown = JSON.parse(decoder.decode(plaintext));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid token");
  }
  return parsed as Record<string, unknown>;
};

const encryptPayload = async (
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `v2.${encode(nonce)}.${encode(new Uint8Array(ciphertext))}`;
};

const isBounded = (value: unknown, maximum = 4_096): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const trustedConfig = (env: AppsHostTrustedEnv): AppsHostConfig => {
  const config = readAppsHostConfig(env);
  if (
    config.hostRole !== "trusted" ||
    !config.builderServiceSecret ||
    !config.appTokenSigningKey
  ) {
    throw new Error("The trusted Apps authority is unavailable.");
  }
  return config;
};

export const verifyAppBootstrap = async (
  config: AppsHostConfig,
  args: { bootstrap: string; origin: string; now?: number },
): Promise<{ appId: string; slug: string }> => {
  if (!config.appTokenSigningKey)
    throw new Error("App token signing is unavailable.");
  const payload = await decryptCapability(
    args.bootstrap,
    config.appTokenSigningKey,
  );
  const now = args.now ?? Date.now();
  if (
    payload.version !== 1 ||
    payload.audience !== APP_BOOTSTRAP_AUDIENCE ||
    payload.issuer !== config.deploymentIdentity ||
    !isBounded(payload.appId, 256) ||
    !isBounded(payload.slug, 64) ||
    payload.origin !== args.origin ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.issuedAt > now + 30_000 ||
    payload.exp <= now ||
    payload.exp <= payload.issuedAt ||
    payload.exp - payload.issuedAt > APP_BOOTSTRAP_TTL_MS
  ) {
    throw new Error("The app bootstrap is invalid or expired.");
  }
  return { appId: payload.appId, slug: payload.slug };
};

export class AppsAuthService extends WorkerEntrypoint<AppsHostTrustedEnv> {
  async mintAppBootstrap(args: {
    appId: string;
    slug: string;
    origin: string;
  }): Promise<{ bootstrap: string; expiresAt: number }> {
    const config = trustedConfig(this.env);
    if (
      !isBounded(args.appId, 256) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(args.slug) ||
      args.origin !== config.appsHostOrigin
    ) {
      throw new Error("The app bootstrap request is invalid.");
    }
    const now = Date.now();
    const expiresAt = now + APP_BOOTSTRAP_TTL_MS;
    return {
      bootstrap: await encryptPayload(
        {
          version: 1,
          audience: APP_BOOTSTRAP_AUDIENCE,
          issuer: config.deploymentIdentity,
          tokenId: crypto.randomUUID(),
          appId: args.appId,
          slug: args.slug,
          origin: args.origin,
          issuedAt: now,
          exp: expiresAt,
        },
        config.appTokenSigningKey!,
      ),
      expiresAt,
    };
  }

  async mintAnonymousSession(args: {
    bootstrap: string;
    origin: string;
    viewerToken: string | null;
  }): Promise<Record<string, unknown>> {
    const config = trustedConfig(this.env);
    if (
      !isBounded(args.bootstrap, 8_192) ||
      !isBounded(args.origin, 2_048) ||
      (args.viewerToken !== null && !isBounded(args.viewerToken, 8_192))
    ) {
      throw new Error("The anonymous app-session request is invalid.");
    }
    const bootstrap = await verifyAppBootstrap(config, args);
    const response = await fetch(
      new URL("/api/apps/session/anonymous", config.convexSiteOrigin),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${config.builderServiceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appId: bootstrap.appId,
          origin: args.origin,
          viewerToken: args.viewerToken,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("The anonymous app session was rejected.");
    }
    const bytes = await readBoundedBytes(
      response.body,
      MAX_SESSION_RESPONSE_BYTES,
    );
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The anonymous app session response was invalid.");
    }
    return parsed as Record<string, unknown>;
  }

  async verifyFetchCapability(args: {
    capability: string;
    origin: string;
    method: string;
    targetOrigin: string;
    targetUrl: string;
    requestHash: string;
    now: number;
  }): Promise<{
    ok: boolean;
    reason?: string;
    tokenId?: string;
    appId?: string;
    viewerNamespace?: string;
    expiresAt?: number;
  }> {
    try {
      const config = trustedConfig(this.env);
      const payload = await decryptCapability(
        args.capability,
        config.appTokenSigningKey!,
      );
      if (
        payload.version !== 1 ||
        payload.audience !== APP_FETCH_AUDIENCE ||
        payload.issuer !== config.deploymentIdentity ||
        !isBounded(payload.tokenId, 128) ||
        !isBounded(payload.appId, 256) ||
        !isBounded(payload.viewerNamespace, 128) ||
        payload.origin !== args.origin ||
        payload.method !== args.method ||
        payload.targetOrigin !== args.targetOrigin ||
        payload.targetUrl !== args.targetUrl ||
        payload.requestHash !== args.requestHash ||
        typeof payload.issuedAt !== "number" ||
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.issuedAt) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.issuedAt > args.now + 30_000 ||
        payload.exp <= args.now ||
        payload.exp - payload.issuedAt > 90_000
      ) {
        return { ok: false, reason: "capability_mismatch" };
      }
      return {
        ok: true,
        tokenId: payload.tokenId,
        appId: payload.appId,
        viewerNamespace: payload.viewerNamespace,
        expiresAt: payload.exp,
      };
    } catch {
      return { ok: false, reason: "invalid_capability" };
    }
  }
}
