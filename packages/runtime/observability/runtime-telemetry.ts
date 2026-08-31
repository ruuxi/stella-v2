import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import type { TelemetryEventBody } from "@stella/contracts/telemetry";
import {
  RemoteTelemetryClient,
  type RemoteTelemetryTransportConfig,
} from "./remote-telemetry.js";

const DEVELOPMENT_ENDPOINT =
  "https://stella-v2-telemetry-dev.lolruuxi.workers.dev/v1/events";
const PRODUCTION_ENDPOINT =
  "https://stella-v2-telemetry.lolruuxi.workers.dev/v1/events";

export type RuntimeTelemetryConfig = {
  stellaDataDirPath: string;
  authToken: string | null;
  isDev?: boolean;
  release?: string;
};

let config: RuntimeTelemetryConfig | null = null;
let client: RemoteTelemetryClient | null = null;
type RuntimeTelemetryBinding = {
  root: string;
  principalScope: string;
  authToken: string;
  environment: "development" | "production";
  endpoint: string;
  release?: string;
};
let binding: RuntimeTelemetryBinding | null = null;

const environmentFor = (value: RuntimeTelemetryConfig) =>
  (value.isDev ?? process.env.STELLA_TELEMETRY_ENVIRONMENT !== "production")
    ? ("development" as const)
    : ("production" as const);

const endpointFor = (environment: "development" | "production"): string => {
  const override = process.env.STELLA_TELEMETRY_ENDPOINT?.trim();
  if (override) return override;
  return environment === "production"
    ? PRODUCTION_ENDPOINT
    : DEVELOPMENT_ENDPOINT;
};

/**
 * Stable, non-reversible lane for one authenticated principal. JWT refreshes
 * retain the same issuer/subject lane; opaque or malformed credentials are
 * isolated by a hash of the complete credential instead of sharing a spool.
 */
export const resolveRuntimeTelemetryPrincipalScope = (
  authToken: string | null | undefined,
): string | null => {
  const normalized = authToken?.trim();
  if (!normalized) return null;

  let identity = `credential:${normalized}`;
  try {
    const payload = JSON.parse(
      Buffer.from(normalized.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const issuer = typeof payload.iss === "string" ? payload.iss.trim() : "";
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const tokenIdentifier =
      typeof payload.tokenIdentifier === "string"
        ? payload.tokenIdentifier.trim()
        : "";
    if (issuer && subject) {
      identity = `subject:${JSON.stringify([issuer, subject])}`;
    } else if (tokenIdentifier) {
      identity = `token:${JSON.stringify(tokenIdentifier)}`;
    }
  } catch {
    // Opaque credentials still get an isolated, non-reversible lane.
  }

  return createHash("sha256")
    .update("stella:runtime-telemetry-principal:v1\0")
    .update(identity)
    .digest("hex");
};

const createBinding = (
  next: RuntimeTelemetryConfig,
): RuntimeTelemetryBinding | null => {
  const authToken = next.authToken?.trim() ?? "";
  const principalScope = resolveRuntimeTelemetryPrincipalScope(authToken);
  if (!authToken || !principalScope) return null;
  const environment = environmentFor(next);
  return {
    root: path.resolve(next.stellaDataDirPath),
    principalScope,
    authToken,
    environment,
    endpoint: endpointFor(environment),
    ...(next.release ? { release: next.release } : {}),
  };
};

const createClient = (next: RuntimeTelemetryBinding): RemoteTelemetryClient =>
  new RemoteTelemetryClient({
    spoolPath: path.join(
      next.root,
      "telemetry",
      `runtime-worker-v2-${next.principalScope}.jsonl`,
    ),
    principalScope: next.principalScope,
    getContext: () => ({
      environment: next.environment,
      source: "runtime-worker",
      ...(next.release ? { release: next.release } : {}),
    }),
    getTransportConfig: (): RemoteTelemetryTransportConfig => ({
      endpoint: next.endpoint,
      authToken: next.authToken,
      principalScope: next.principalScope,
    }),
  });

/**
 * Configure the worker-owned telemetry client from the authenticated host
 * session. The runtime process is the only network owner; renderer code never
 * imports this module.
 */
export const configureRuntimeTelemetry = (
  next: RuntimeTelemetryConfig,
): void => {
  const resolvedRoot = path.resolve(next.stellaDataDirPath);
  config = { ...next, stellaDataDirPath: resolvedRoot };
  const nextBinding = createBinding(config);

  if (
    client &&
    binding &&
    nextBinding &&
    binding.root === nextBinding.root &&
    binding.principalScope === nextBinding.principalScope
  ) {
    // Same principal, refreshed credential/config. Mutating this private
    // binding is safe because this client owns only that principal's spool.
    Object.assign(binding, nextBinding);
    return;
  }

  const previous = client;
  binding = nextBinding;
  client = nextBinding ? createClient(nextBinding) : null;

  // v1 had no principal binding and therefore cannot be attributed safely.
  // Never migrate it into a scoped queue.
  void unlink(
    path.join(resolvedRoot, "telemetry", "runtime-worker-v1.jsonl"),
  ).catch(() => undefined);
  if (previous) void previous.close({ timeoutMs: 1_000 });
};

export const updateRuntimeTelemetryAuth = (authToken: string | null): void => {
  if (config) configureRuntimeTelemetry({ ...config, authToken });
};

/** Best-effort, metadata-only enqueue. This function never throws. */
export const recordRuntimeTelemetry = (event: TelemetryEventBody): void => {
  if (client) void client.record(event);
};

export const closeRuntimeTelemetry = async (): Promise<void> => {
  const active = client;
  client = null;
  binding = null;
  config = null;
  await active?.close({ timeoutMs: 3_000 }).catch(() => undefined);
};
