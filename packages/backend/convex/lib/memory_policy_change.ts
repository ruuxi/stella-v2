import { ConvexError } from "convex/values";
import {
  MEMORY_POLICY_CHANGE_PATH,
  type MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import { resolveBuilderEndpoint } from "./builder_turns";

/** Settings changes are acknowledged only after the owner gate has applied them. */
export const synchronizeMemoryPolicyChange = async (
  change: MemoryPolicyChange,
): Promise<void> => {
  const endpoint = resolveBuilderEndpoint();
  if (!endpoint) throw new ConvexError({ code: "MEMORY_POLICY_UNAVAILABLE" });
  const response = await fetch(`${endpoint.url}${MEMORY_POLICY_CHANGE_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(change),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      const code =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        /^[A-Z_]{1,100}$/u.test(body.error)
          ? body.error
          : "MEMORY_POLICY_CHANGE_REFUSED";
      throw new ConvexError({ code });
    }
    throw new ConvexError({
      code: "MEMORY_POLICY_CHANGE_PENDING",
      message:
        "The memory setting is still being synchronized. Retry with the same request.",
    });
  }
};
