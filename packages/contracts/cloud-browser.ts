/**
 * Provider-neutral, secret-free contracts for Stella Cloud browser work.
 *
 * Browser cookies, storage state, Live View capability URLs, provider device
 * secrets, OAuth tokens, and credential-field values are deliberately absent.
 * Those values belong only to the private Browser Gateway.
 */

export const CLOUD_BROWSER_INTERACTION_KINDS = [
  "login_takeover",
  "device_code",
] as const;

export type CloudBrowserInteractionKind =
  (typeof CLOUD_BROWSER_INTERACTION_KINDS)[number];

export const CLOUD_BROWSER_INTERACTION_STATES = [
  "pending",
  "human_control",
  "resuming",
  "completed",
  "canceled",
  "expired",
  "failed",
] as const;

export type CloudBrowserInteractionState =
  (typeof CLOUD_BROWSER_INTERACTION_STATES)[number];

export type CloudBrowserInteractionDecision = "done" | "cancel";

export type CloudBrowserInteractionSummary = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  kind: CloudBrowserInteractionKind;
  state: CloudBrowserInteractionState;
  displayOrigin: string;
  displayTitle?: string;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}>;

export type CloudBrowserLoginTakeoverDetail =
  CloudBrowserInteractionSummary &
    Readonly<{
      kind: "login_takeover";
    }>;

/** Only the public RFC 8628 values intended to be shown to the user. */
export type CloudBrowserDeviceCodeDetail = CloudBrowserInteractionSummary &
  Readonly<{
    kind: "device_code";
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
  }>;

export type CloudBrowserInteractionDetail =
  | CloudBrowserLoginTakeoverDetail
  | CloudBrowserDeviceCodeDetail;

/**
 * A JIT bearer capability. It must be returned only to the authenticated
 * client, held in memory, validated against `live.browser.run`, and discarded
 * when the takeover surface closes or backgrounds.
 */
export type CloudBrowserLiveViewCapability = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  revision: number;
  url: string;
  expiresAt: number;
}>;

/**
 * Typed control outcome that suspends one hosted Stella turn. This is safe to
 * checkpoint and project; it contains no browser state or human-entered data.
 */
export type CloudBrowserSuspension = Readonly<{
  schemaVersion: 1;
  outcome: "waiting_for_user";
  interactionId: string;
  interactionRevision: number;
  interactionKind: CloudBrowserInteractionKind;
  toolCallId: string;
  requestDigest: string;
  profileId: string;
  profileEpoch: number;
  displayOrigin: string;
  displayTitle?: string;
  expiresAt: number;
}>;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isBoundedString = (
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  new TextEncoder().encode(value).byteLength <= maxBytes;

const isDisplayOrigin = (value: unknown): value is string => {
  if (!isBoundedString(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      value === parsed.origin
    );
  } catch {
    return false;
  }
};

export const isCloudBrowserSuspension = (
  value: unknown,
): value is CloudBrowserSuspension => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyKeys(candidate, [
      "schemaVersion",
      "outcome",
      "interactionId",
      "interactionRevision",
      "interactionKind",
      "toolCallId",
      "requestDigest",
      "profileId",
      "profileEpoch",
      "displayOrigin",
      "displayTitle",
      "expiresAt",
    ]) &&
    candidate.schemaVersion === 1 &&
    candidate.outcome === "waiting_for_user" &&
    isBoundedString(candidate.interactionId, 256) &&
    Number.isSafeInteger(candidate.interactionRevision) &&
    (candidate.interactionRevision as number) >= 1 &&
    CLOUD_BROWSER_INTERACTION_KINDS.includes(
      candidate.interactionKind as CloudBrowserInteractionKind,
    ) &&
    isBoundedString(candidate.toolCallId, 256) &&
    typeof candidate.requestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.requestDigest) &&
    candidate.profileId === "default" &&
    Number.isSafeInteger(candidate.profileEpoch) &&
    (candidate.profileEpoch as number) >= 1 &&
    isDisplayOrigin(candidate.displayOrigin) &&
    (candidate.displayTitle === undefined ||
      isBoundedString(candidate.displayTitle, 256, true)) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    (candidate.expiresAt as number) > 0
  );
};

/** Gateway command envelope. Exact owner/turn identity is broker-derived. */
export type CloudBrowserCommandRequest = Readonly<{
  schemaVersion: 1;
  requestId: string;
  action: string;
  params: Readonly<Record<string, unknown>>;
}>;

export type CloudBrowserCommandResponse =
  | Readonly<{
      schemaVersion: 1;
      outcome: "completed";
      requestId: string;
      data?: unknown;
    }>
  | Readonly<{
      schemaVersion: 1;
      outcome: "suspended";
      suspension: CloudBrowserSuspension;
    }>
  | Readonly<{
      schemaVersion: 1;
      outcome: "failed";
      requestId: string;
      code: string;
      message: string;
      outcomeUnknown?: boolean;
    }>;

export type CloudBrowserResumeReceipt = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  interactionRevision: number;
  profileId: string;
  profileEpoch: number;
  toolCallId: string;
  requestDigest: string;
  result: "approved" | "canceled" | "expired" | "failed";
  safeMessage: string;
}>;

export const isCloudBrowserResumeReceipt = (
  value: unknown,
): value is CloudBrowserResumeReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyKeys(candidate, [
      "schemaVersion",
      "interactionId",
      "interactionRevision",
      "profileId",
      "profileEpoch",
      "toolCallId",
      "requestDigest",
      "result",
      "safeMessage",
    ]) &&
    candidate.schemaVersion === 1 &&
    isBoundedString(candidate.interactionId, 256) &&
    Number.isSafeInteger(candidate.interactionRevision) &&
    (candidate.interactionRevision as number) >= 1 &&
    candidate.profileId === "default" &&
    Number.isSafeInteger(candidate.profileEpoch) &&
    (candidate.profileEpoch as number) >= 1 &&
    isBoundedString(candidate.toolCallId, 256) &&
    typeof candidate.requestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.requestDigest) &&
    typeof candidate.result === "string" &&
    ["approved", "canceled", "expired", "failed"].includes(
      candidate.result,
    ) &&
    isBoundedString(candidate.safeMessage, 2_048)
  );
};
