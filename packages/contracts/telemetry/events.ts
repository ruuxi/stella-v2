/**
 * Metadata-only telemetry contract shared by Stella producers and ingestion.
 *
 * This is intentionally a closed schema. It has no arbitrary `fields`,
 * `properties`, message, stack, prompt, response, URL, path, or tool-argument
 * escape hatch. New metadata must be reviewed and added as a named field.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_PROJECT = "stella" as const;

export type TelemetryEnvironment =
  | "development"
  | "preview"
  | "production"
  | "test";

export type TelemetrySource =
  | "desktop-main"
  | "runtime-worker"
  | "convex-backend"
  | "cloud-builder"
  | "executor-cloud"
  | "apps-host"
  | "browser-gateway"
  | "mobile";

export type TelemetryComponent = TelemetrySource | "desktop-renderer";

export type AppLifecycleTelemetry = {
  type: "app.lifecycle";
  component: TelemetryComponent;
  phase: "starting" | "ready" | "stopping" | "stopped" | "crashed";
  durationMs?: number;
  exitCode?: number;
  reasonCode?: string;
};

export type AppErrorTelemetry = {
  type: "app.error";
  component: TelemetryComponent;
  severity: "warning" | "error" | "fatal";
  errorClass?: string;
  errorCode?: string;
  /** Stable hash/fingerprint only; never the original message or stack. */
  fingerprint?: string;
  recovered?: boolean;
};

export type AppPerformanceTelemetry = {
  type: "app.performance";
  component: TelemetryComponent;
  metric:
    | "startup"
    | "first-paint"
    | "worker-ready"
    | "cloud-readiness"
    | "request"
    | "turn"
    | "tool";
  durationMs: number;
  outcome?: "success" | "failure" | "timeout" | "canceled" | "unavailable";
};

export type InferenceCompletedTelemetry = {
  type: "inference.completed";
  provider: string;
  model: string;
  responseModel?: string;
  agentType: string;
  durationMs: number;
  success: boolean;
  stopReason?: "stop" | "length" | "tool-use" | "error" | "aborted";
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costMicroCents?: number;
  fallbackUsed?: boolean;
  toolCalls?: number;
  physicalAttempts?: number;
};

export type ProviderTransportTelemetry = {
  type: "provider.transport";
  provider: string;
  model: string;
  /** SHA-256 lowercase hex. Raw provider request IDs are forbidden. */
  requestIdSha256: string;
  phase:
    | "request-admitted"
    | "request-dispatched"
    | "stream-open"
    | "transport-closed"
    | "transport-joined"
    | "abandoned"
    | "outcome-unknown";
  physicalAttempt: number;
  streamOrdinal?: number;
  outcome?: "completed" | "canceled" | "error";
  durationMs?: number;
};

export type ToolCompletedTelemetry = {
  type: "tool.completed";
  toolName: string;
  agentType: string;
  durationMs: number;
  success: boolean;
  outcomeCode?: string;
};

export type CloudTurnTelemetry = {
  type: "cloud.turn";
  workload: "agent" | "app-build";
  phase:
    | "started"
    | "completed"
    | "failed"
    | "canceled"
    | "suspended"
    | "resumed";
  wallClockMs?: number;
  coldContainerStartMs?: number;
  restoreMs?: number;
  checkpointMs?: number;
  activeCpuMs?: number;
  uploadedBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  llmCalls?: number;
  instanceType?: string;
  failureCode?: string;
};

export type TelemetryEventBody =
  | AppLifecycleTelemetry
  | AppErrorTelemetry
  | AppPerformanceTelemetry
  | InferenceCompletedTelemetry
  | ProviderTransportTelemetry
  | ToolCompletedTelemetry
  | CloudTurnTelemetry;

export type TelemetryEventV1 = {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  occurredAtMs: number;
  project: typeof TELEMETRY_PROJECT;
  environment: TelemetryEnvironment;
  source: TelemetrySource;
  release?: string;
  /** SHA-256 pseudonyms only. Raw installation/owner identifiers are forbidden. */
  installationIdSha256?: string;
  ownerIdSha256?: string;
  event: TelemetryEventBody;
};

export type TelemetryEventContext = Pick<
  TelemetryEventV1,
  "environment" | "source"
> &
  Partial<
    Pick<TelemetryEventV1, "release" | "installationIdSha256" | "ownerIdSha256">
  >;

export type TelemetryBatchV1 = {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  events: TelemetryEventV1[];
};

const ENVIRONMENTS = new Set<TelemetryEnvironment>([
  "development",
  "preview",
  "production",
  "test",
]);
const SOURCES = new Set<TelemetrySource>([
  "desktop-main",
  "runtime-worker",
  "convex-backend",
  "cloud-builder",
  "executor-cloud",
  "apps-host",
  "browser-gateway",
  "mobile",
]);
const COMPONENTS = new Set<TelemetryComponent>([
  ...SOURCES,
  "desktop-renderer",
]);
const HASH = /^[0-9a-f]{64}$/;
const EVENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_PROVIDER_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]*)*$/;
const PATH_OR_URL_PREFIX =
  /^(?:[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/|[\\/]|\.{1,2}(?:[\\/]|$))/;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isBoundedLabel = (value: unknown, max = 160): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  SAFE_LABEL.test(value);

const isOptionalLabel = (value: unknown, max = 160): boolean =>
  value === undefined || isBoundedLabel(value, max);

/**
 * Provider and model identifiers are the only remote labels allowed to use
 * slash-delimited namespaces (for example `anthropic/claude-sonnet-4`). Empty,
 * dot, and dot-dot path segments as well as URL/absolute-path forms cannot
 * match this grammar.
 */
const isProviderModelId = (value: unknown, max = 160): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !PATH_OR_URL_PREFIX.test(value) &&
  SAFE_PROVIDER_MODEL_ID.test(value);

const isOptionalProviderModelId = (value: unknown, max = 160): boolean =>
  value === undefined || isProviderModelId(value, max);

const isCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

const isDuration = (value: unknown): value is number =>
  isCount(value) && value <= 30 * 24 * 60 * 60_000;

const isOptionalCount = (value: unknown): boolean =>
  value === undefined || isCount(value);

const isInt32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= INT32_MIN &&
  value <= INT32_MAX;

const isNonNegativeInt32 = (value: unknown): value is number =>
  isInt32(value) && value >= 0;

const isOptionalNonNegativeInt32 = (value: unknown): boolean =>
  value === undefined || isNonNegativeInt32(value);

const isOptionalDuration = (value: unknown): boolean =>
  value === undefined || isDuration(value);

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === "boolean";

const isOneOf = <T extends string>(
  value: unknown,
  options: readonly T[],
): value is T => typeof value === "string" && options.includes(value as T);

export const isTelemetryEventBody = (
  value: unknown,
): value is TelemetryEventBody => {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "app.lifecycle":
      return (
        onlyKeys(value, [
          "type",
          "component",
          "phase",
          "durationMs",
          "exitCode",
          "reasonCode",
        ]) &&
        COMPONENTS.has(value.component as TelemetryComponent) &&
        isOneOf(value.phase, [
          "starting",
          "ready",
          "stopping",
          "stopped",
          "crashed",
        ]) &&
        isOptionalDuration(value.durationMs) &&
        (value.exitCode === undefined || isInt32(value.exitCode)) &&
        isOptionalLabel(value.reasonCode, 96)
      );
    case "app.error":
      return (
        onlyKeys(value, [
          "type",
          "component",
          "severity",
          "errorClass",
          "errorCode",
          "fingerprint",
          "recovered",
        ]) &&
        COMPONENTS.has(value.component as TelemetryComponent) &&
        isOneOf(value.severity, ["warning", "error", "fatal"]) &&
        isOptionalLabel(value.errorClass, 128) &&
        isOptionalLabel(value.errorCode, 96) &&
        (value.fingerprint === undefined ||
          (typeof value.fingerprint === "string" &&
            HASH.test(value.fingerprint))) &&
        isOptionalBoolean(value.recovered)
      );
    case "app.performance":
      return (
        onlyKeys(value, [
          "type",
          "component",
          "metric",
          "durationMs",
          "outcome",
        ]) &&
        COMPONENTS.has(value.component as TelemetryComponent) &&
        isOneOf(value.metric, [
          "startup",
          "first-paint",
          "worker-ready",
          "cloud-readiness",
          "request",
          "turn",
          "tool",
        ]) &&
        isDuration(value.durationMs) &&
        (value.outcome === undefined ||
          isOneOf(value.outcome, [
            "success",
            "failure",
            "timeout",
            "canceled",
            "unavailable",
          ]))
      );
    case "inference.completed":
      return (
        onlyKeys(value, [
          "type",
          "provider",
          "model",
          "responseModel",
          "agentType",
          "durationMs",
          "success",
          "stopReason",
          "inputTokens",
          "outputTokens",
          "cachedInputTokens",
          "cacheWriteInputTokens",
          "reasoningTokens",
          "totalTokens",
          "costMicroCents",
          "fallbackUsed",
          "toolCalls",
          "physicalAttempts",
        ]) &&
        isProviderModelId(value.provider) &&
        isProviderModelId(value.model) &&
        isOptionalProviderModelId(value.responseModel) &&
        isBoundedLabel(value.agentType, 96) &&
        isDuration(value.durationMs) &&
        typeof value.success === "boolean" &&
        (value.stopReason === undefined ||
          isOneOf(value.stopReason, [
            "stop",
            "length",
            "tool-use",
            "error",
            "aborted",
          ])) &&
        [
          value.inputTokens,
          value.outputTokens,
          value.cachedInputTokens,
          value.cacheWriteInputTokens,
          value.reasoningTokens,
          value.totalTokens,
          value.costMicroCents,
        ].every(isOptionalCount) &&
        isOptionalNonNegativeInt32(value.toolCalls) &&
        isOptionalNonNegativeInt32(value.physicalAttempts) &&
        isOptionalBoolean(value.fallbackUsed)
      );
    case "provider.transport":
      return (
        onlyKeys(value, [
          "type",
          "provider",
          "model",
          "requestIdSha256",
          "phase",
          "physicalAttempt",
          "streamOrdinal",
          "outcome",
          "durationMs",
        ]) &&
        isProviderModelId(value.provider) &&
        isProviderModelId(value.model) &&
        typeof value.requestIdSha256 === "string" &&
        HASH.test(value.requestIdSha256) &&
        isOneOf(value.phase, [
          "request-admitted",
          "request-dispatched",
          "stream-open",
          "transport-closed",
          "transport-joined",
          "abandoned",
          "outcome-unknown",
        ]) &&
        isNonNegativeInt32(value.physicalAttempt) &&
        isOptionalNonNegativeInt32(value.streamOrdinal) &&
        (value.outcome === undefined ||
          isOneOf(value.outcome, ["completed", "canceled", "error"])) &&
        isOptionalDuration(value.durationMs)
      );
    case "tool.completed":
      return (
        onlyKeys(value, [
          "type",
          "toolName",
          "agentType",
          "durationMs",
          "success",
          "outcomeCode",
        ]) &&
        isBoundedLabel(value.toolName, 128) &&
        isBoundedLabel(value.agentType, 96) &&
        isDuration(value.durationMs) &&
        typeof value.success === "boolean" &&
        isOptionalLabel(value.outcomeCode, 96)
      );
    case "cloud.turn":
      return (
        onlyKeys(value, [
          "type",
          "workload",
          "phase",
          "wallClockMs",
          "coldContainerStartMs",
          "restoreMs",
          "checkpointMs",
          "activeCpuMs",
          "uploadedBytes",
          "inputTokens",
          "outputTokens",
          "llmCalls",
          "instanceType",
          "failureCode",
        ]) &&
        isOneOf(value.workload, ["agent", "app-build"]) &&
        isOneOf(value.phase, [
          "started",
          "completed",
          "failed",
          "canceled",
          "suspended",
          "resumed",
        ]) &&
        [
          value.wallClockMs,
          value.coldContainerStartMs,
          value.restoreMs,
          value.checkpointMs,
          value.activeCpuMs,
        ].every(isOptionalDuration) &&
        [value.uploadedBytes, value.inputTokens, value.outputTokens].every(
          isOptionalCount,
        ) &&
        isOptionalNonNegativeInt32(value.llmCalls) &&
        isOptionalLabel(value.instanceType, 96) &&
        isOptionalLabel(value.failureCode, 96)
      );
    default:
      return false;
  }
};

export const isTelemetryEventV1 = (value: unknown): value is TelemetryEventV1 =>
  isRecord(value) &&
  onlyKeys(value, [
    "schemaVersion",
    "eventId",
    "occurredAtMs",
    "project",
    "environment",
    "source",
    "release",
    "installationIdSha256",
    "ownerIdSha256",
    "event",
  ]) &&
  value.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
  typeof value.eventId === "string" &&
  EVENT_ID.test(value.eventId) &&
  isCount(value.occurredAtMs) &&
  value.project === TELEMETRY_PROJECT &&
  ENVIRONMENTS.has(value.environment as TelemetryEnvironment) &&
  SOURCES.has(value.source as TelemetrySource) &&
  isOptionalLabel(value.release, 96) &&
  (value.installationIdSha256 === undefined ||
    (typeof value.installationIdSha256 === "string" &&
      HASH.test(value.installationIdSha256))) &&
  (value.ownerIdSha256 === undefined ||
    (typeof value.ownerIdSha256 === "string" &&
      HASH.test(value.ownerIdSha256))) &&
  isTelemetryEventBody(value.event);

export const isTelemetryBatchV1 = (value: unknown): value is TelemetryBatchV1 =>
  isRecord(value) &&
  onlyKeys(value, ["schemaVersion", "events"]) &&
  value.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
  Array.isArray(value.events) &&
  value.events.length > 0 &&
  value.events.length <= 500 &&
  value.events.every(isTelemetryEventV1);
