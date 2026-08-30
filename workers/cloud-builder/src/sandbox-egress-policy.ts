export type EgressDestinationTelemetry = {
  event: "sandbox_egress_destination";
  workload: "agent" | "app-build";
  phase: "broad" | "sealed";
  decision: "allow" | "deny";
  scheme: "http" | "https";
  destinationHost: string;
  destinationPort: number;
};

/**
 * Produce the complete egress event. Deliberately omit the URL path, query,
 * fragment, headers, and body so observability cannot become a content log.
 */
export const egressDestinationTelemetry = (
  request: Request,
  fields: Pick<EgressDestinationTelemetry, "workload" | "phase" | "decision">,
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
  fields: Pick<EgressDestinationTelemetry, "workload" | "phase" | "decision">,
): void => {
  try {
    const event = egressDestinationTelemetry(request, fields);
    if (event) console.log(JSON.stringify(event));
  } catch {
    // Observability must never widen app-build egress or break intentional
    // general-agent connectivity. The policy decision remains authoritative.
  }
};

export const generalAgentEgress = async (
  request: Request,
): Promise<Response> => {
  emitDestinationTelemetry(request, {
    workload: "agent",
    phase: "broad",
    decision: "allow",
  });
  // Preserve streaming request bodies and Cloudflare's native fetch semantics.
  return await fetch(request);
};

export const appBuildEgress = async (request: Request): Promise<Response> => {
  emitDestinationTelemetry(request, {
    workload: "app-build",
    phase: "sealed",
    decision: "deny",
  });
  return new Response("App-build network access is sealed.", { status: 403 });
};
