import {
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryBatchV1,
  type TelemetryBatchV1,
  type TelemetryEventV1,
} from "@stella/contracts/telemetry";
import { MAX_BATCH_EVENTS } from "./constants.js";

export type { TelemetryBatchV1, TelemetryEventV1 } from "@stella/contracts/telemetry";

export type ParseResult =
  | { ok: true; batch: TelemetryBatchV1 }
  | { ok: false; error: string };

export const parseBatch = (value: unknown): ParseResult => {
  if (!isTelemetryBatchV1(value)) return { ok: false, error: "invalid_schema" };
  if (value.events.length > MAX_BATCH_EVENTS) return { ok: false, error: "batch_too_large" };
  return { ok: true, batch: value };
};

export const batchFromEvents = (events: TelemetryEventV1[]): TelemetryBatchV1 => ({
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  events,
});
