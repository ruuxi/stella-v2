import type { TelemetryEnvironment } from "@stella/contracts/telemetry";

const DEVELOPMENT_ENDPOINT =
  "https://stella-v2-telemetry-dev.lolruuxi.workers.dev/v1/events";
const PRODUCTION_ENDPOINT =
  "https://stella-v2-telemetry.lolruuxi.workers.dev/v1/events";

export const telemetryHttpEnvironment = (
  isDev: boolean,
): Extract<TelemetryEnvironment, "development" | "production"> =>
  isDev ? "development" : "production";

export const telemetryHttpEndpoint = (
  environment: Extract<TelemetryEnvironment, "development" | "production">,
): string =>
  process.env.STELLA_TELEMETRY_ENDPOINT?.trim() ||
  (environment === "production" ? PRODUCTION_ENDPOINT : DEVELOPMENT_ENDPOINT);
