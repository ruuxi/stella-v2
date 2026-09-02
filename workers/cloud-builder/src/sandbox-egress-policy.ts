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

type EgressRefusalReason = NonNullable<EgressDestinationTelemetry["reason"]>;
type EgressDecision =
  | { decision: "allow"; reason?: never }
  | { decision: "deny"; reason?: EgressRefusalReason };

type SandboxOutboundContext = {
  /** Stable sandbox Durable Object id. Stella uses one id per turn. */
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

type TurnEgressState = {
  responseBytes: number;
  requestTimes: number[];
  lastSeenAt: number;
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

const meteredResponse = (args: {
  request: Request;
  response: Response;
  state: TurnEgressState;
  budgetBytes: number;
}): Response => {
  if (!args.response.body) return args.response;
  const reader = args.response.body.getReader();
  let budgetTelemetrySent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        args.state.responseBytes += part.value.byteLength;
        if (
          args.state.responseBytes > args.budgetBytes &&
          !budgetTelemetrySent
        ) {
          budgetTelemetrySent = true;
          emitDestinationTelemetry(args.request, {
            workload: "agent",
            phase: "broad",
            decision: "deny",
            reason: "egress_budget",
          });
        }
        controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
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
 * Stateful policy factory. Production keys state by `ctx.containerId`, which
 * is Stella's exact-turn sandbox id. Tests inject small limits and a clock.
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
  const turns = new Map<string, TurnEgressState>();

  return async (request, _env, context): Promise<Response> => {
    const now = deps.now();
    for (const [id, state] of turns) {
      if (state.lastSeenAt < now - EGRESS_STATE_RETENTION_MS) turns.delete(id);
    }
    const turnId = context?.containerId.trim() || "unscoped";
    let state = turns.get(turnId);
    if (!state) {
      state = { responseBytes: 0, requestTimes: [], lastSeenAt: now };
      turns.set(turnId, state);
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
    if (state.responseBytes >= deps.limits.budgetBytes) {
      return refusal(
        request,
        403,
        "egress_budget",
        "This turn's network download budget is used up.",
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
        "This turn is opening network connections too quickly.",
      );
    }
    state.requestTimes.push(now);

    emitDestinationTelemetry(request, {
      workload: "agent",
      phase: "broad",
      decision: "allow",
    });
    // Preserve streaming request bodies and Cloudflare's native fetch semantics.
    const response = await deps.fetch(request);
    const declaredBytes = boundedContentLength(response);
    if (
      declaredBytes !== null &&
      state.responseBytes + declaredBytes > deps.limits.budgetBytes
    ) {
      await response.body?.cancel("egress_budget");
      return refusal(
        request,
        403,
        "egress_budget",
        "This response would exceed the turn's network download budget.",
      );
    }
    return meteredResponse({
      request,
      response,
      state,
      budgetBytes: deps.limits.budgetBytes,
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
