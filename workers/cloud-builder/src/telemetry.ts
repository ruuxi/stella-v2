import type {
  CloudTurnTelemetry,
  TelemetryEventV1,
} from "@stella/contracts/telemetry";

type TelemetryRpc = {
  ingest(events: TelemetryEventV1[]): Promise<void>;
};

type TelemetryEnv = {
  TELEMETRY_ENVIRONMENT: "development" | "production";
  TELEMETRY?: unknown;
};

/**
 * Best-effort private Worker-to-Worker telemetry. Business delivery never
 * waits on analytics, and no turn/user identifiers or content leave Builder.
 */
export const emitCloudTurnTelemetry = (
  ctx: Pick<ExecutionContext, "waitUntil">,
  env: TelemetryEnv,
  event: CloudTurnTelemetry,
): void => {
  if (!env.TELEMETRY) return;
  // Wrangler cannot infer another deployed Worker's named-entrypoint RPC
  // shape, so the binding is generated as Service and narrowed at this one
  // reviewed boundary.
  const telemetry = env.TELEMETRY as TelemetryRpc;
  const envelope: TelemetryEventV1 = {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    occurredAtMs: Date.now(),
    project: "stella",
    environment: env.TELEMETRY_ENVIRONMENT,
    source: "cloud-builder",
    event,
  };
  ctx.waitUntil(telemetry.ingest([envelope]).catch(() => undefined));
};
