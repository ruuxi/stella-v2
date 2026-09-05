import { WorkerEntrypoint } from "cloudflare:workers";
import { authenticateCapability } from "./capability.js";
import { GatewayError } from "./errors.js";
import { managedCancellationIdentity } from "./managed-cancellation.js";
import { isGatewayRequestId } from "./request-util.js";

export class ModelGatewayControl extends WorkerEntrypoint<Env> {
  /**
   * Best-effort owner-scoped preparation for trusted Worker callers. This
   * entrypoint deliberately performs no capability validation, inference, or
   * accounting: the caller has already authenticated the owner object and the
   * relay gate only warms its configuration and enforcement reads.
   */
  async prepareOwner(args: { ownerId: string }): Promise<void> {
    const ownerId = typeof args?.ownerId === "string" ? args.ownerId : "";
    if (!ownerId || ownerId.length > 512) {
      throw new GatewayError(
        400,
        "bad_request",
        "The owner preparation request is invalid.",
      );
    }
    await this.env.OWNER_RELAY_GATE.get(
      this.env.OWNER_RELAY_GATE.idFromName(ownerId),
    ).prepare(ownerId);
  }

  async cancelManagedRequest(args: {
    capability: string;
    requestId: string;
  }): Promise<{ canceled: boolean }> {
    if (
      typeof args.capability !== "string" ||
      args.capability.length === 0 ||
      args.capability.length > 16_384 ||
      !isGatewayRequestId(args.requestId)
    ) {
      throw new GatewayError(
        400,
        "bad_request",
        "The cancellation request is invalid.",
      );
    }
    const auth = await authenticateCapability(
      new Request("https://gateway.invalid", {
        headers: { authorization: `Bearer ${args.capability}` },
      }),
      this.env,
      { allowProbe: false },
    );
    const identity = managedCancellationIdentity({
      claims: auth.claims,
      requestId: args.requestId,
    });
    if (!identity) {
      throw new GatewayError(
        403,
        "capability_invalid",
        "This capability cannot cancel a managed request.",
      );
    }
    return await this.env.OWNER_RELAY_GATE.get(
      this.env.OWNER_RELAY_GATE.idFromName(identity.ownerId),
    ).cancelManagedRequest(identity);
  }
}
