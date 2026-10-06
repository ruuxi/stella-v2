/**
 * Shared (browser-safe) vocabulary for "couldn't resolve an LLM route".
 *
 * The runtime route resolver (runtime/kernel/model-routing.ts) builds these
 * failures and throws `formatLlmRouteFailure(...)`. The desktop toast resolver
 * (desktop/src/features/chat/streaming/stella-provider-error-toast.ts) maps the
 * thrown message back to an actionable toast via `detectLlmRouteFailureKind`.
 *
 * The two ends are linked by the stable `kind` markers embedded in the
 * message — NEVER by matching human-readable prose. Reworded or translated copy
 * therefore can't silently drop the specific error handling. Keep the
 * `formatLlmRouteFailure`/`detectLlmRouteFailureKind` round-trip aligned.
 */
import { getProviderDisplayName } from "./provider-display.js";

export type LlmRouteFailure =
  | { kind: "unsupported-provider"; provider: string; model: string }
  | {
      kind: "unknown-model";
      provider: string;
      model: string;
      suggestedModel?: string;
    }
  | {
      kind: "missing-credential";
      provider: string;
      model: string;
      /**
       * The reference the user actually selected, when the resolver rewrote it
       * before resolving. `codex/<m>` and `codex-cli/<m>` both normalize to
       * `chatgpt/<m>`, so without this the error names a provider segment the
       * user never typed and reads like Stella picked the wrong thing.
       */
      requestedModel?: string;
    }
  | { kind: "no-stella-route" };

export type LlmRouteFailureKind = LlmRouteFailure["kind"];

/**
 * Stable, machine-readable markers appended to thrown route-failure messages.
 * UI matches on these tokens, not the surrounding prose.
 */
export const LLM_ROUTE_FAILURE_MARKERS: Record<LlmRouteFailureKind, string> = {
  "unsupported-provider": "stella.route_error.unsupported_provider",
  "unknown-model": "stella.route_error.unknown_model",
  "missing-credential": "stella.route_error.missing_credential",
  "no-stella-route": "stella.route_error.no_stella_route",
};

const markerSuffix = (kind: LlmRouteFailureKind): string =>
  ` [${LLM_ROUTE_FAILURE_MARKERS[kind]}]`;

/**
 * Providers whose credential is a signed-in account rather than a pasted key,
 * with the remedy that actually works for each.
 *
 * Only providers where `subscriptionPowersDirectRoutes` (model-routing.ts) is
 * true belong here. ChatGPT does: a `chatgpt/` route (which is what `codex/`
 * and `codex-cli/` normalize to) is served by this computer's own Sign in with
 * ChatGPT account calling the public Responses API directly — no CLI is
 * involved. So pointing at the API-key field in Settings → Model sends the
 * user somewhere that cannot hold the credential the route needs.
 *
 * Name BOTH working options. Sign in with ChatGPT registers each install as
 * its own agent host (`chatgpt-siwc.ts`: per-host `ext_agent_host_id` and
 * issued client id, each refreshing its own tokens), and the owner's cloud is
 * one more host whose tokens stay on the server. So a cloud connection cannot
 * cover this computer — but it does serve the same model on a cloud turn,
 * which needs no new sign-in.
 *
 * Anthropic deliberately does NOT belong here: a Claude subscription is only
 * ever handed to the Claude Code CLI, and an `anthropic/` route really does
 * need an API key — so the default copy is already correct for it.
 */
const ACCOUNT_CREDENTIAL_REMEDIES: Record<string, string> = {
  chatgpt:
    "Sign in with ChatGPT in Settings → Account to use it here, or run this task in the cloud, where the ChatGPT account connected to your Stella account already serves it. Sign in with ChatGPT registers each computer as its own host, so a cloud connection does not cover this one.",
};

/**
 * Name the selection the user made, and the route it normalized to when those
 * differ, so a rewritten provider segment is visible instead of looking like a
 * resolver mistake.
 */
const describeSelection = (
  model: string,
  requestedModel: string | undefined,
): string => {
  const requested = requestedModel?.trim();
  return requested && requested !== model
    ? `selected model "${requested}", which routes as "${model}"`
    : `selected model "${model}"`;
};

/**
 * Render a route failure into a user-facing message with a trailing stable
 * marker. The prose is for humans and logs; the marker is the contract the UI
 * matches on.
 */
export const formatLlmRouteFailure = (failure: LlmRouteFailure): string => {
  switch (failure.kind) {
    case "missing-credential": {
      const name = getProviderDisplayName(failure.provider);
      const selection = describeSelection(
        failure.model,
        failure.requestedModel,
      );
      const accountRemedy = ACCOUNT_CREDENTIAL_REMEDIES[failure.provider];
      if (accountRemedy) {
        // A ChatGPT account connected for CLOUD agents is deliberately kept on
        // Stella's server and never handed to this computer's runtime
        // (`DEVICE_AUTH_PROVIDERS` is Claude only), so "I already connected it"
        // and "this computer has no credential" are both true at once. Say
        // that, instead of asking for a key this route cannot use.
        return `No ${name} credential on this computer (${selection}). ${accountRemedy}${markerSuffix(failure.kind)}`;
      }
      return `No usable API key for ${name} (${selection}). Add or re-check your ${name} key in Settings → Model, or pick another model.${markerSuffix(failure.kind)}`;
    }
    case "unknown-model": {
      if (!failure.suggestedModel) {
        return `Selected model "${failure.model}" is not available from ${getProviderDisplayName(failure.provider)}. Pick a different model in Settings → Model.${markerSuffix(failure.kind)}`;
      }
      const engineName = failure.suggestedModel.startsWith("codex/")
        ? "the Codex engine"
        : failure.suggestedModel.startsWith("claude-code/")
          ? "the Claude Code engine"
          : "another engine";
      return `Selected model "${failure.model}" is not available from ${getProviderDisplayName(failure.provider)}. It is served by ${engineName}; use "${failure.suggestedModel}" instead.${markerSuffix(failure.kind)}`;
    }
    case "unsupported-provider":
      return `Unknown model provider "${failure.provider}" (selected model "${failure.model}"). Pick a different model in Settings → Model.${markerSuffix(failure.kind)}`;
    case "no-stella-route":
      return `No usable model route is configured. Sign in to use Stella, or add a provider API key in Settings.${markerSuffix(failure.kind)}`;
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
};

/**
 * Recover the failure kind from a thrown message via its stable marker.
 * Returns null when the message isn't a recognized route failure.
 */
export const detectLlmRouteFailureKind = (
  message: string | null | undefined,
): LlmRouteFailureKind | null => {
  if (!message) return null;
  for (const kind of Object.keys(
    LLM_ROUTE_FAILURE_MARKERS,
  ) as LlmRouteFailureKind[]) {
    if (message.includes(LLM_ROUTE_FAILURE_MARKERS[kind])) {
      return kind;
    }
  }
  return null;
};
