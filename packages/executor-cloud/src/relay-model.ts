import type { Api, Model } from "@stella/runtime/ai/types.js";
import { stellaManagedRelayBaseUrlFromSiteUrl } from "@stella/contracts/stella-api";

/**
 * Header carrying the opaque per-turn token to Convex. The relay resolves it
 * to the turn's owner (plan gating + metering bill that owner); the cloud
 * event/message callback routes accept it scoped to the token's turn.
 */
export const CLOUD_TURN_TOKEN_HEADER = "x-stella-turn-token";

/**
 * Selects the owner's connected engine subscription for this turn's model
 * calls. The header carries only the provider name — the relay resolves the
 * owner from the turn token and uses their stored OAuth token server-side;
 * the credential itself never reaches the DO or sandbox.
 */
export const CLOUD_LLM_CREDENTIAL_HEADER = "x-stella-llm-credential";

/** Engine a cloud turn runs on, resolved by Convex at dispatch. */
export type CloudEngineSelection = {
  provider: "anthropic";
  /** Engine-native model id, e.g. "claude-sonnet-4.6". */
  model: string;
};

export const DEFAULT_CLOUD_ANTHROPIC_ENGINE_MODEL = "claude-sonnet-4.6";

/**
 * The cloud executor's model route: Stella's managed relay, authenticated by
 * the turn token instead of a user JWT. Pinned to an explicit Anthropic
 * managed model so the request body shape always matches the
 * anthropic-messages adapter — `stella`-mode aliases can resolve to
 * non-Anthropic defaults per audience, which this route cannot follow.
 */
export const createCloudRelayModel = (args: {
  siteUrl: string;
  turnToken: string;
  agentType: string;
  /**
   * Run this turn on the owner's connected engine subscription instead of
   * the managed gateway. Convex only sets this after verifying the
   * credential exists; the relay re-verifies and refreshes server-side.
   */
  engine?: CloudEngineSelection;
}): Model<Api> =>
  args.engine
    ? {
        id: `stella/anthropic/${args.engine.model}`,
        name: "Claude (subscription)",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: stellaManagedRelayBaseUrlFromSiteUrl(args.siteUrl),
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_384,
        headers: {
          "X-Stella-Agent-Type": args.agentType,
          [CLOUD_TURN_TOKEN_HEADER]: args.turnToken,
          [CLOUD_LLM_CREDENTIAL_HEADER]: args.engine.provider,
        },
      }
    : {
        // Must stay in CLOUD_EXECUTOR_PINNED_MODEL_IDS (convex/agent/model.ts):
        // that allowlist is what lets restricted audiences (free/go) use this
        // pin, and its membership in ADDITIONAL_MANAGED_MODEL_IDS is what
        // prices it. Changing this id without updating both silently breaks
        // free/go chat.
        id: "stella/anthropic/claude-sonnet-4.6",
        name: "Stella Cloud",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: stellaManagedRelayBaseUrlFromSiteUrl(args.siteUrl),
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 80_000,
        maxTokens: 16_384,
        headers: {
          "X-Stella-Agent-Type": args.agentType,
          [CLOUD_TURN_TOKEN_HEADER]: args.turnToken,
        },
      };
