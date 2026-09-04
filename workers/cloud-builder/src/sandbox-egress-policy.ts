export type EgressDestinationTelemetry = {
  event: "sandbox_egress_destination";
  workload: "agent" | "app-build";
  phase: "broad" | "sealed";
  decision: "allow" | "deny";
  scheme: "http" | "https";
  destinationHost: string;
  destinationPort: number;
  reason?: "egress_budget" | "connection_rate" | "destination_port";
};

export const GENERAL_AGENT_EGRESS_BUDGET_BYTES = 500 * 1024 * 1024;
export const GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE = 120;
export const GENERAL_AGENT_EGRESS_ALLOWED_PORTS = [80, 443, 22] as const;
const EGRESS_RATE_WINDOW_MS = 60_000;
const EGRESS_STATE_RETENTION_MS = 60 * 60_000;

/**
 * This outbound fetch handler only observes HTTP(S) requests routed to it by
 * the Sandbox SDK. It is not a firewall for non-HTTP traffic: port 22 remains
 * enabled for legitimate Git SSH traffic and is outside this byte/rate meter.
 * Quota state is isolate-local and intentionally not described as durable.
 */

type EgressRefusalReason = NonNullable<EgressDestinationTelemetry["reason"]>;
type EgressDecision =
  | { decision: "allow"; reason?: never }
  | { decision: "deny"; reason?: EgressRefusalReason };

type SandboxOutboundContext = {
  /** Stable sandbox Durable Object id. Agents share one id per owner world. */
  containerId: string;
};

type GeneralAgentEgressLimits = {
  budgetBytes: number;
  requestsPerMinute: number;
};

type GeneralAgentEgressDeps = {
  fetch: (request: Request) => Promise<Response>;
  now: () => number;
  limits: GeneralAgentEgressLimits;
};

type ContainerEgressState = {
  responseBytes: number;
  reservedResponseBytes: number;
  requestTimes: number[];
  lastSeenAt: number;
  inFlightRequests: number;
  activeResponses: number;
};

/**
 * Produce the complete egress event. Deliberately omit the URL path, query,
 * fragment, headers, and body so observability cannot become a content log.
 */
export const egressDestinationTelemetry = (
  request: Request,
  fields: Pick<EgressDestinationTelemetry, "workload" | "phase"> &
    EgressDecision,
): EgressDestinationTelemetry | null => {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    event: "sandbox_egress_destination",
    ...fields,
    scheme: url.protocol === "https:" ? "https" : "http",
    destinationHost: url.hostname.toLowerCase(),
    destinationPort: url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80,
  };
};

const emitDestinationTelemetry = (
  request: Request,
  fields: Pick<EgressDestinationTelemetry, "workload" | "phase"> &
    EgressDecision,
): void => {
  try {
    const event = egressDestinationTelemetry(request, fields);
    if (event) console.log(JSON.stringify(event));
  } catch {
    // Observability must never widen app-build egress or break intentional
    // general-agent connectivity. The policy decision remains authoritative.
  }
};

const destinationPort = (url: URL): number =>
  url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;

const refusal = (
  request: Request,
  status: 403 | 429,
  reason: EgressRefusalReason,
  message: string,
): Response => {
  emitDestinationTelemetry(request, {
    workload: "agent",
    phase: "broad",
    decision: "deny",
    reason,
  });
  return new Response(message, { status });
};

const boundedContentLength = (response: Response): number | null => {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const cancelBestEffort = (cancel: () => Promise<void>): void => {
  try {
    // Refusal must not wait for a broken upstream cancellation handshake.
    // Attach a rejection handler so fire-and-forget cancellation stays quiet.
    void cancel().catch(() => undefined);
  } catch {
    // Some implementations can throw synchronously (for example if locked).
  }
};

const meteredResponse = (args: {
  request: Request;
  response: Response;
  state: ContainerEgressState;
  budgetBytes: number;
  reservedBytes: number;
  now: () => number;
}): Response => {
  if (!args.response.body) return args.response;
  const reader = args.response.body.getReader();
  let remainingReservation = args.reservedBytes;
  let finished = false;
  args.state.activeResponses += 1;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    args.state.reservedResponseBytes -= remainingReservation;
    remainingReservation = 0;
    args.state.activeResponses -= 1;
    args.state.lastSeenAt = args.now();
  };
  const refuseChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    // Saturate accounting at the cap. A transport may already have received
    // this one chunk, but none of the chunk is exposed to the sandbox.
    const available = Math.max(
      0,
      args.budgetBytes -
        args.state.responseBytes -
        args.state.reservedResponseBytes,
    );
    args.state.responseBytes += available;
    emitDestinationTelemetry(args.request, {
      workload: "agent",
      phase: "broad",
      decision: "deny",
      reason: "egress_budget",
    });
    finish();
    cancelBestEffort(() => reader.cancel("isolate_local_egress_budget"));
    controller.error(
      new Error(
        "This worker isolate's tracked download budget for the container is exhausted; it resets after one hour without egress activity.",
      ),
    );
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        args.state.lastSeenAt = args.now();
        if (part.done) {
          finish();
          controller.close();
          return;
        }

        const coveredByReservation = Math.min(
          remainingReservation,
          part.value.byteLength,
        );
        remainingReservation -= coveredByReservation;
        args.state.reservedResponseBytes -= coveredByReservation;
        const available = Math.max(
          0,
          args.budgetBytes -
            args.state.responseBytes -
            args.state.reservedResponseBytes,
        );
        if (part.value.byteLength > available) {
          refuseChunk(controller);
          return;
        }
        args.state.responseBytes += part.value.byteLength;
        controller.enqueue(part.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: args.response.status,
    statusText: args.response.statusText,
    headers: args.response.headers,
  });
};

/**
 * Stateful policy factory. Production keys an isolate-local Map by
 * `ctx.containerId`, Stella's owner-world sandbox id. Idle entries reset after
 * one hour when a later request sweeps them; this is not a durable quota.
 * Tests inject small limits and a clock.
 */
export const createGeneralAgentEgress = (
  overrides: Partial<GeneralAgentEgressDeps> = {},
): ((
  request: Request,
  env?: unknown,
  context?: SandboxOutboundContext,
) => Promise<Response>) => {
  const deps: GeneralAgentEgressDeps = {
    fetch: async (request) => await fetch(request),
    now: Date.now,
    limits: {
      budgetBytes: GENERAL_AGENT_EGRESS_BUDGET_BYTES,
      requestsPerMinute: GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE,
    },
    ...overrides,
  };
  const containers = new Map<string, ContainerEgressState>();

  return async (request, _env, context): Promise<Response> => {
    const now = deps.now();
    for (const [id, state] of containers) {
      if (
        state.inFlightRequests === 0 &&
        state.activeResponses === 0 &&
        state.lastSeenAt <= now - EGRESS_STATE_RETENTION_MS
      ) {
        containers.delete(id);
      }
    }
    const containerId = context?.containerId.trim() || "unscoped";
    let state = containers.get(containerId);
    if (!state) {
      state = {
        responseBytes: 0,
        reservedResponseBytes: 0,
        requestTimes: [],
        lastSeenAt: now,
        inFlightRequests: 0,
        activeResponses: 0,
      };
      containers.set(containerId, state);
    }
    state.lastSeenAt = now;

    const url = new URL(request.url);
    const port = destinationPort(url);
    if (
      !GENERAL_AGENT_EGRESS_ALLOWED_PORTS.some((allowed) => allowed === port)
    ) {
      return refusal(
        request,
        403,
        "destination_port",
        "That destination port is not allowed.",
      );
    }
    if (
      state.responseBytes + state.reservedResponseBytes >=
      deps.limits.budgetBytes
    ) {
      return refusal(
        request,
        403,
        "egress_budget",
        "This worker isolate's tracked download budget for the container is used up; it resets after one hour without egress activity.",
      );
    }

    state.requestTimes = state.requestTimes.filter(
      (at) => at > now - EGRESS_RATE_WINDOW_MS && at <= now,
    );
    if (state.requestTimes.length >= deps.limits.requestsPerMinute) {
      return refusal(
        request,
        429,
        "connection_rate",
        "This container has reached this worker isolate's rolling one-minute HTTP request limit.",
      );
    }
    state.requestTimes.push(now);

    emitDestinationTelemetry(request, {
      workload: "agent",
      phase: "broad",
      decision: "allow",
    });
    // Preserve streaming request bodies and Cloudflare's native fetch semantics.
    // An attempted fetch consumes a rate slot even if the upstream later fails.
    // This prevents retry storms from bypassing the connection-rate guard.
    state.inFlightRequests += 1;
    let response: Response;
    try {
      response = await deps.fetch(request);
    } finally {
      state.inFlightRequests -= 1;
      state.lastSeenAt = deps.now();
    }
    if (!response.body) return response;

    const declaredBytes = boundedContentLength(response);
    if (
      declaredBytes !== null &&
      state.responseBytes + state.reservedResponseBytes + declaredBytes >
        deps.limits.budgetBytes
    ) {
      cancelBestEffort(() =>
        response.body!.cancel("isolate_local_egress_budget"),
      );
      return refusal(
        request,
        403,
        "egress_budget",
        "This response would exceed this worker isolate's tracked download budget for the container; it resets after one hour without egress activity.",
      );
    }
    const reservedBytes = declaredBytes ?? 0;
    state.reservedResponseBytes += reservedBytes;
    return meteredResponse({
      request,
      response,
      state,
      budgetBytes: deps.limits.budgetBytes,
      reservedBytes,
      now: deps.now,
    });
  };
};

export const generalAgentEgress = createGeneralAgentEgress();

export const appBuildEgress = async (request: Request): Promise<Response> => {
  emitDestinationTelemetry(request, {
    workload: "app-build",
    phase: "sealed",
    decision: "deny",
  });
  return new Response("App-build network access is sealed.", { status: 403 });
};
