export const STELLA_BROWSER_BRIDGE_STATES = [
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "host_registration_failed",
] as const;

export type StellaBrowserBridgeState =
  (typeof STELLA_BROWSER_BRIDGE_STATES)[number];

export const STELLA_BROWSER_BRIDGE_FAILURE_REASONS = [
  "bridge_missing",
  "authorization_failed",
  "connection_lost",
  "transient_failure",
] as const;

export type StellaBrowserBridgeFailureReason =
  (typeof STELLA_BROWSER_BRIDGE_FAILURE_REASONS)[number];

export type StellaBrowserBridgeStatus = {
  state: StellaBrowserBridgeState;
  attempt: number;
  nextRetryMs?: number;
  error?: string;
  reason?: StellaBrowserBridgeFailureReason;
  /**
   * Legacy flag from older desktop builds. Optional browser-bridge
   * absence/loss is never a global toast, so this must stay ignored.
   */
  notifyUser?: boolean;
};

/**
 * The browser extension/bridge is optional. Absence, disconnection, host
 * registration failure, and silent retry are in-feature connection states,
 * never a global app error toast. Both the desktop resource and the
 * renderer toast listener must go through this gate.
 */
export const shouldEmitBrowserBridgeGlobalToast = (_status: {
  state?: string;
  reason?: string;
  notifyUser?: boolean;
  error?: string;
  attempt?: number;
  nextRetryMs?: number;
}): boolean => false;
