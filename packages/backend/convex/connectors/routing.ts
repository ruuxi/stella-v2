/**
 * Pure, deterministic route resolution. Given a connector's rollout record, the
 * global kill switch, the caller, and the operation class, decide which
 * executor runs — and, critically, when NOT to fall back.
 *
 * Invariants (design §1, §10):
 *  - Executor is an implementation detail; connector ids never change.
 *  - Mutating actions are never automatically replayed across executors.
 *  - Shadow mode never dual-executes provider actions; first-party does
 *    read-only readiness comparison only.
 *  - The global env kill switch blocks ALL first-party execution (fail closed).
 */

export const ROLLOUT_MODES = [
  "composio_only",
  "shadow",
  "first_party_canary",
  "first_party_preferred",
  "first_party_only",
  "disabled",
] as const;

export type RolloutMode = (typeof ROLLOUT_MODES)[number];

export type ConnectorOperation = "read" | "write" | "destructive";

export type ConnectorRollout = {
  connectorId: string;
  mode: RolloutMode;
  canaryPercent?: number;
  saltVersion?: number;
  allowedFallbacks?: string[];
  minimumClientVersion?: string;
  routeVersion: number;
};

export type ConnectorExecutor = "composio" | "first_party" | "refused";

export type RouteDecision = {
  executor: ConnectorExecutor;
  mode: RolloutMode;
  routeVersion: number;
  /** True when first-party should run a read-only readiness probe alongside Composio. */
  shadowEvaluate: boolean;
  /** True when preferred mode wants a first-party connect/upgrade prompt. */
  firstPartyConnectSuggested: boolean;
  /**
   * Whether a route/config failure BEFORE any provider request may fall back to
   * a verified Composio connection. Only ever true for reads. Writes never fall
   * back automatically.
   */
  allowReadFallbackToComposio: boolean;
  reasonCode: string;
};

export const DEFAULT_ROLLOUT: ConnectorRollout = {
  connectorId: "",
  mode: "composio_only",
  routeVersion: 0,
};

/**
 * Deterministic, uniform bucketing for canary cohorts. This is NOT a security
 * decision, so a fast synchronous FNV-1a hash is used instead of async SHA-256.
 * The same (ownerId, connectorId, saltVersion) always maps to the same bucket.
 */
export const canaryBucket = (
  ownerId: string,
  connectorId: string,
  saltVersion: number,
): number => {
  const input = `${saltVersion}:${connectorId}:${ownerId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 10000; // 0..9999 -> two-decimal percentage precision
};

const isCanarySelected = (rollout: ConnectorRollout, ownerId: string): boolean => {
  const percent = Math.max(0, Math.min(100, rollout.canaryPercent ?? 0));
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket = canaryBucket(ownerId, rollout.connectorId, rollout.saltVersion ?? 1);
  return bucket < Math.round(percent * 100);
};

const allowsComposioFallback = (rollout: ConnectorRollout): boolean =>
  Array.isArray(rollout.allowedFallbacks) &&
  rollout.allowedFallbacks.includes("composio");

export const resolveRoute = (args: {
  rollout: ConnectorRollout;
  ownerId: string;
  operation: ConnectorOperation;
  killSwitchEnabled: boolean;
  /** A bound first-party account exists AND has every required scope. */
  hasFirstPartyReady: boolean;
}): RouteDecision => {
  const { rollout, ownerId, operation, killSwitchEnabled, hasFirstPartyReady } =
    args;
  const base = {
    mode: rollout.mode,
    routeVersion: rollout.routeVersion,
    shadowEvaluate: false,
    firstPartyConnectSuggested: false,
    allowReadFallbackToComposio: false,
  };

  if (rollout.mode === "disabled") {
    return { ...base, executor: "refused", reasonCode: "connector_disabled" };
  }

  // Global emergency kill switch: no first-party execution at all.
  if (!killSwitchEnabled) {
    if (rollout.mode === "first_party_only") {
      // Migrated connector but first-party globally blocked. Fail closed:
      // operators roll back by setting the route to composio_only, not by
      // silently using Composio here.
      return {
        ...base,
        executor: "refused",
        reasonCode: "execution_disabled",
      };
    }
    return { ...base, executor: "composio", reasonCode: "kill_switch_off" };
  }

  switch (rollout.mode) {
    case "composio_only":
      return { ...base, executor: "composio", reasonCode: "composio_only" };

    case "shadow":
      // Composio executes; first-party only evaluates readiness (reads only).
      return {
        ...base,
        executor: "composio",
        shadowEvaluate: true,
        reasonCode: "shadow",
      };

    case "first_party_canary": {
      if (isCanarySelected(rollout, ownerId) && hasFirstPartyReady) {
        return { ...base, executor: "first_party", reasonCode: "canary_selected" };
      }
      return {
        ...base,
        executor: "composio",
        reasonCode: isCanarySelected(rollout, ownerId)
          ? "canary_selected_not_ready"
          : "canary_not_selected",
      };
    }

    case "first_party_preferred": {
      if (hasFirstPartyReady) {
        return { ...base, executor: "first_party", reasonCode: "preferred_ready" };
      }
      // Do not silently use a different Composio account; suggest connect.
      return {
        ...base,
        executor: "composio",
        firstPartyConnectSuggested: true,
        allowReadFallbackToComposio:
          operation === "read" && allowsComposioFallback(rollout),
        reasonCode: "preferred_not_ready",
      };
    }

    case "first_party_only":
      // Composio disabled for this connector. Readiness is enforced downstream;
      // an unready account surfaces reauth/connect, never a Composio fallback.
      return {
        ...base,
        executor: "first_party",
        reasonCode: "first_party_only",
      };

    default: {
      const exhaustive: never = rollout.mode;
      throw new Error(`Unhandled rollout mode: ${String(exhaustive)}`);
    }
  }
};

/** Whether the current Composio path must refuse this connector (post-migration). */
export const composioPathBlocked = (mode: RolloutMode): boolean =>
  mode === "first_party_only" || mode === "disabled";
