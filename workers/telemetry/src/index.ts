import { WorkerEntrypoint } from "cloudflare:workers";
import { bearerCredential } from "../../shared/bearer.js";
import { verifyUserToken } from "./auth-jwt.js";
import {
  MAX_BODY_BYTES,
  MAX_EVENT_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  SCHEMA_VERSION,
} from "./constants.js";
import {
  canonicalUserOwnerKey,
  createPseudonymizer,
} from "./pseudonym.js";
import {
  batchFromEvents,
  parseBatch,
  type TelemetryEventV1,
} from "./schema.js";
import { verifyServiceBearer } from "./service-bearer.js";

export type { TelemetryEventV1 } from "./schema.js";

type TelemetryEnv = Pick<
  Env,
  | "ENVIRONMENT"
  | "STELLA_BACKEND_URL"
  | "ENABLE_SERVER_BEARER"
  | "TELEMETRY_PSEUDONYM_KEY"
  | "TELEMETRY_SERVER_SECRET"
  | "EVENTS_PIPELINE"
  | "TELEMETRY_RATE_LIMITER"
>;
export type TelemetryBindings = TelemetryEnv;
type TelemetryPipelineRecord = Cloudflare.StellaTelemetryDevStreamV1Record &
  Cloudflare.StellaTelemetryProdStreamV1Record;
type Principal = { kind: "user" | "service"; identity: string };

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};
const json = (
  status: number,
  body: Record<string, unknown>,
  requestId?: string,
): Response =>
  Response.json(body, {
    status,
    headers: requestId ? { ...headers, "x-request-id": requestId } : headers,
  });

const readBoundedBytes = async (
  request: Request,
  maximumBytes = MAX_BODY_BYTES,
): Promise<Uint8Array> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new Error("body_too_large");
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("body_too_large");
        throw new Error("body_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseJsonBytes = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new Error("invalid_json");
  }
};

const readBoundedJson = async (request: Request): Promise<unknown> =>
  parseJsonBytes(await readBoundedBytes(request));

const authenticate = async (
  request: Request,
  env: TelemetryEnv,
): Promise<
  | { ok: true; principal: Principal }
  | { ok: false; status: number; reason: string }
> => {
  const token = bearerCredential(request.headers.get("authorization"));
  if (token?.split(".").length === 3) {
    const result = await verifyUserToken(token, env.STELLA_BACKEND_URL);
    if (result.ok)
      return {
        ok: true,
        principal: { kind: "user", identity: result.ownerId },
      };
    return {
      ok: false,
      status: result.retryable ? 503 : 401,
      reason: result.reason,
    };
  }
  const valid =
    env.ENABLE_SERVER_BEARER === "1" &&
    (await verifyServiceBearer(
      request.headers.get("authorization"),
      env.TELEMETRY_SERVER_SECRET,
    ));
  const serviceId = request.headers.get("x-stella-service-id")?.trim() ?? "";
  if (valid && /^[A-Za-z0-9._:-]{1,128}$/u.test(serviceId)) {
    return {
      ok: true,
      principal: { kind: "service", identity: `service:${serviceId}` },
    };
  }
  return { ok: false, status: 401, reason: "unauthorized" };
};

const flattenEvent = (
  item: TelemetryEventV1,
  ownerIdSha256: string,
  principalKind: Principal["kind"],
  ingestedAtMs: number,
): Record<string, unknown> => {
  const common = {
    schema_version: item.schemaVersion,
    event_id: item.eventId,
    occurred_at_ms: item.occurredAtMs,
    ingested_at_ms: ingestedAtMs,
    project: item.project,
    environment: item.environment,
    source: item.source,
    release: item.release ?? null,
    installation_id_sha256: item.installationIdSha256 ?? null,
    // Never trust a producer-supplied owner hash; bind every event to auth.
    owner_id_sha256: ownerIdSha256,
    principal_kind: principalKind,
    event_type: item.event.type,
  };
  // Every variant emits the same nullable column set so the Pipeline's inferred
  // schema remains stable as new event kinds arrive in a batch.
  const empty = {
    component: null,
    phase: null,
    duration_ms: null,
    exit_code: null,
    reason_code: null,
    severity: null,
    error_class: null,
    error_code: null,
    fingerprint: null,
    recovered: null,
    metric: null,
    outcome: null,
    provider: null,
    model: null,
    response_model: null,
    agent_type: null,
    success: null,
    stop_reason: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    cost_micro_cents: null,
    fallback_used: null,
    tool_calls: null,
    physical_attempts: null,
    provider_request_id_sha256: null,
    physical_attempt: null,
    stream_ordinal: null,
    tool_name: null,
    outcome_code: null,
    workload: null,
    wall_clock_ms: null,
    cold_container_start_ms: null,
    restore_ms: null,
    checkpoint_ms: null,
    active_cpu_ms: null,
    uploaded_bytes: null,
    llm_calls: null,
    instance_type: null,
    failure_code: null,
  };
  const event = item.event;
  switch (event.type) {
    case "app.lifecycle":
      return {
        ...common,
        ...empty,
        component: event.component,
        phase: event.phase,
        duration_ms: event.durationMs ?? null,
        exit_code: event.exitCode ?? null,
        reason_code: event.reasonCode ?? null,
      };
    case "app.error":
      return {
        ...common,
        ...empty,
        component: event.component,
        severity: event.severity,
        error_class: event.errorClass ?? null,
        error_code: event.errorCode ?? null,
        fingerprint: event.fingerprint ?? null,
        recovered: event.recovered ?? null,
      };
    case "app.performance":
      return {
        ...common,
        ...empty,
        component: event.component,
        metric: event.metric,
        duration_ms: event.durationMs,
        outcome: event.outcome ?? null,
      };
    case "inference.completed":
      return {
        ...common,
        ...empty,
        provider: event.provider,
        model: event.model,
        response_model: event.responseModel ?? null,
        agent_type: event.agentType,
        duration_ms: event.durationMs,
        success: event.success,
        stop_reason: event.stopReason ?? null,
        input_tokens: event.inputTokens ?? null,
        output_tokens: event.outputTokens ?? null,
        cached_input_tokens: event.cachedInputTokens ?? null,
        cache_write_input_tokens: event.cacheWriteInputTokens ?? null,
        reasoning_tokens: event.reasoningTokens ?? null,
        total_tokens: event.totalTokens ?? null,
        cost_micro_cents: event.costMicroCents ?? null,
        fallback_used: event.fallbackUsed ?? null,
        tool_calls: event.toolCalls ?? null,
        physical_attempts: event.physicalAttempts ?? null,
      };
    case "provider.transport":
      return {
        ...common,
        ...empty,
        provider: event.provider,
        model: event.model,
        provider_request_id_sha256: event.requestIdSha256,
        phase: event.phase,
        physical_attempt: event.physicalAttempt,
        stream_ordinal: event.streamOrdinal ?? null,
        outcome: event.outcome ?? null,
        duration_ms: event.durationMs ?? null,
      };
    case "tool.completed":
      return {
        ...common,
        ...empty,
        tool_name: event.toolName,
        agent_type: event.agentType,
        duration_ms: event.durationMs,
        success: event.success,
        outcome_code: event.outcomeCode ?? null,
      };
    case "cloud.turn":
      return {
        ...common,
        ...empty,
        workload: event.workload,
        phase: event.phase,
        wall_clock_ms: event.wallClockMs ?? null,
        cold_container_start_ms: event.coldContainerStartMs ?? null,
        restore_ms: event.restoreMs ?? null,
        checkpoint_ms: event.checkpointMs ?? null,
        active_cpu_ms: event.activeCpuMs ?? null,
        uploaded_bytes: event.uploadedBytes ?? null,
        input_tokens: event.inputTokens ?? null,
        output_tokens: event.outputTokens ?? null,
        llm_calls: event.llmCalls ?? null,
        instance_type: event.instanceType ?? null,
        failure_code: event.failureCode ?? null,
      };
  }
};

const ingestValidated = async (
  events: TelemetryEventV1[],
  principal: Principal,
  env: TelemetryEnv,
): Promise<string> => {
  if (events.some((event) => event.environment !== env.ENVIRONMENT)) {
    throw new TypeError("environment_mismatch");
  }
  const now = Date.now();
  if (
    events.some(
      (event) =>
        event.occurredAtMs < now - MAX_EVENT_AGE_MS ||
        event.occurredAtMs > now + MAX_FUTURE_SKEW_MS,
    )
  ) {
    throw new TypeError("event_time_out_of_range");
  }
  const pseudonymize = await createPseudonymizer(
    env.TELEMETRY_PSEUDONYM_KEY,
    env.ENVIRONMENT,
  );
  const ownerIdentity =
    principal.kind === "user"
      ? await canonicalUserOwnerKey(principal.identity)
      : principal.identity;
  const ownerIdSha256 = await pseudonymize("owner", ownerIdentity);
  const ingestedAtMs = Date.now();
  const output = events.map((event) =>
    flattenEvent(event, ownerIdSha256, principal.kind, ingestedAtMs),
  );
  // The generated binding types model nullable schema columns as optional.
  // Pipelines expects the full fixed-width record with explicit nulls, so the
  // cast lives only at this closed, validated serialization boundary.
  await env.EVENTS_PIPELINE.send(
    output as unknown as TelemetryPipelineRecord[],
  );
  return ownerIdSha256;
};

export const fetchHandler = async (
  request: Request,
  env: TelemetryEnv,
): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const path = new URL(request.url).pathname;
  if (path === "/health") {
    return request.method === "GET"
      ? json(
          200,
          {
            ok: true,
            service: "telemetry",
            environment: env.ENVIRONMENT,
            schemaVersion: SCHEMA_VERSION,
          },
          requestId,
        )
      : json(405, { error: "method_not_allowed" }, requestId);
  }
  if (path !== "/v1/events")
    return json(404, { error: "not_found" }, requestId);
  if (request.method !== "POST") {
    const response = json(405, { error: "method_not_allowed" }, requestId);
    response.headers.set("allow", "POST");
    return response;
  }
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json")
    return json(415, { error: "unsupported_media_type" }, requestId);
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    console.warn({
      event: "telemetry.auth_rejected",
      requestId,
      reason: auth.reason,
    });
    return json(
      auth.status,
      {
        error:
          auth.status === 503 ? "authentication_unavailable" : "unauthorized",
      },
      requestId,
    );
  }
  const pseudonymize = await createPseudonymizer(
    env.TELEMETRY_PSEUDONYM_KEY,
    env.ENVIRONMENT,
  );
  const rateKey = await pseudonymize("owner", auth.principal.identity);
  if (!(await env.TELEMETRY_RATE_LIMITER.limit({ key: rateKey })).success) {
    const response = json(429, { error: "rate_limited" }, requestId);
    response.headers.set("retry-after", "60");
    return response;
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const code =
      error instanceof Error && error.message === "body_too_large"
        ? "body_too_large"
        : "invalid_json";
    return json(
      code === "body_too_large" ? 413 : 400,
      { error: code },
      requestId,
    );
  }
  const parsed = parseBatch(body);
  if (!parsed.ok)
    return json(
      400,
      { error: "invalid_payload", detail: parsed.error },
      requestId,
    );
  let actorId: string;
  try {
    actorId = await ingestValidated(parsed.batch.events, auth.principal, env);
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error.message === "environment_mismatch" ||
        error.message === "event_time_out_of_range")
    ) {
      return json(400, { error: error.message }, requestId);
    }
    console.error({
      event: "telemetry.pipeline_failed",
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json(503, { error: "ingestion_unavailable" }, requestId);
  }
  console.log({
    event: "telemetry.accepted",
    requestId,
    actorId,
    principalKind: auth.principal.kind,
    count: parsed.batch.events.length,
  });
  return json(
    202,
    { accepted: parsed.batch.events.length, requestId },
    requestId,
  );
};

export class TelemetryService extends WorkerEntrypoint<Env> {
  /**
   * Events about one owner from a trusted Worker (cloud-builder's billing
   * ledger), pseudonymized under that owner like a signed-in client's.
   */
  async ingestForOwner(ownerId: string, events: TelemetryEventV1[]): Promise<void> {
    if (typeof ownerId !== "string" || !ownerId.trim()) {
      throw new TypeError("Invalid telemetry owner.");
    }
    const parsed = parseBatch(batchFromEvents(events));
    if (!parsed.ok)
      throw new TypeError(`Invalid telemetry payload: ${parsed.error}`);
    await ingestValidated(
      parsed.batch.events,
      { kind: "user", identity: ownerId },
      this.env,
    );
  }

  async ingest(events: TelemetryEventV1[]): Promise<void> {
    const parsed = parseBatch(batchFromEvents(events));
    if (!parsed.ok)
      throw new TypeError(`Invalid telemetry payload: ${parsed.error}`);
    await ingestValidated(
      parsed.batch.events,
      { kind: "service", identity: "service:rpc" },
      this.env,
    );
    console.log({
      event: "telemetry.rpc_accepted",
      count: parsed.batch.events.length,
    });
  }
}

export default { fetch: fetchHandler } satisfies ExportedHandler<Env>;
