import { OwnerRelayGate } from "../../src/gates/owner-relay-gate.js";
export { OwnerRelayGate };
import { OwnerCapabilityLedger } from "../../src/owner-capability-ledger.js";
export { OwnerCapabilityLedger };
export default {
  async fetch(
    request: Request,
    env: { LEDGERS: DurableObjectNamespace<OwnerCapabilityLedger>; GATES: DurableObjectNamespace<OwnerRelayGate> },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ready");
    const ledger = env.LEDGERS.getByName(
      url.searchParams.get("owner") ?? "owner",
    );
    const jti = url.searchParams.get("jti") ?? "a";
    const requestId = url.searchParams.get("request") ?? "same";
    if (url.pathname === "/atomic") return Response.json(await env.GATES.getByName("owner").admitAndReserve({
      audience: "pro", requestId, throttled: false, generation: "gen-1",
      reservation: { jti, requestId, budgetMicroCents: 1000, estimatedMicroCents: 400, expiresAt: Date.now() + 3600000 },
    }));
    if (url.pathname === "/reserve")
      return Response.json(
        await ledger.reserve({
          jti,
          requestId,
          budgetMicroCents: 1000,
          maxRequests: 2,
          estimatedMicroCents: 400,
          expiresAt:
            Number(url.searchParams.get("expires")) || Date.now() + 3600000,
        }),
      );
    if (url.pathname === "/settle")
      return Response.json(
        await ledger.settle({
          jti,
          requestId,
          chargedMicroCents: 200,
          refundRequest: false,
          result: { status: 200, body: `reply:${jti}` },
        }),
      );
    if (url.pathname === "/snapshot")
      return Response.json(await ledger.snapshot({ jti }));
    if (url.pathname === "/replay")
      return Response.json(await ledger.replay({ jti, requestId }));
    return new Response("not found", { status: 404 });
  },
};
