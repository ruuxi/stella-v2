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

  notifyUser?: boolean;
};

export const shouldEmitBrowserBridgeGlobalToast = (_status: {
  state?: string;
  reason?: string;
  notifyUser?: boolean;
  error?: string;
  attempt?: number;
  nextRetryMs?: number;
}): boolean => false;
