import type { TelemetryEnvironment } from "@stella/contracts/telemetry";

const DEVELOPMENT_ENDPOINT =
  "https://stella-v2-telemetry-dev.fromyou.workers.dev/v1/events";
const PRODUCTION_ENDPOINT =
  "https://stella-v2-telemetry.fromyou.workers.dev/v1/events";

/**
 * The backends whose tokens the default endpoints verify. A JWT's `iss` is
 * the backend that minted it, so a self-hosted deployment's tokens never go
 * to these endpoints; its telemetry is off unless STELLA_TELEMETRY_ENDPOINT
 * names its own telemetry worker.
 */
const DEFAULT_ENDPOINT_ISSUERS: ReadonlySet<string> = new Set([
  "https://stella-v2-cloud-builder-dev.fromyou.workers.dev",
  "https://stella-v2-cloud-builder-prod.fromyou.workers.dev",
]);

const tokenIssuer = (authToken: string): string | null => {
  try {
    const payload = JSON.parse(
      Buffer.from(authToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
};

export const telemetryHttpEnvironment = (
  isDev: boolean,
): Extract<TelemetryEnvironment, "development" | "production"> =>
  isDev ? "development" : "production";

/** Where to send events carrying `authToken`, or null when telemetry is off. */
export const telemetryHttpEndpoint = (
  environment: Extract<TelemetryEnvironment, "development" | "production">,
  authToken: string,
): string | null => {
  const configured = process.env.STELLA_TELEMETRY_ENDPOINT?.trim();
  if (configured) return configured;
  if (!DEFAULT_ENDPOINT_ISSUERS.has(tokenIssuer(authToken) ?? "")) return null;
  return environment === "production" ? PRODUCTION_ENDPOINT : DEVELOPMENT_ENDPOINT;
};
