import { GatewayError } from "./errors.js";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const PROFILE_ID = "default";

export const TURN_ACTIONS = [
  "browser.open",
  "browser.navigate",
  "browser.observe",
  "browser.click",
  "browser.fill",
  "browser.press",
  "browser.select",
  "browser.wait",
  "browser.tabs",
  "browser.focus_tab",
  "browser.checkpoint",
  "browser.login_takeover",
  "browser.close",
  "device_code.fixture_start",
] as const;

export type TurnAction = (typeof TURN_ACTIONS)[number];

export type TurnAuthority = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
}>;

export type OwnerAuthority = Readonly<{
  ownerId: string;
  ownerGeneration: string;
}>;

export type CloudBrowserCommand = Readonly<{
  schemaVersion: 1;
  requestId: string;
  action: TurnAction;
  params: Readonly<Record<string, unknown>>;
}>;

export type TurnCommandEnvelope = Readonly<{
  schemaVersion: 1;
  authority: TurnAuthority;
  command: CloudBrowserCommand;
}>;

export type InteractionEnvelope = Readonly<{
  schemaVersion: 1;
  authority: TurnAuthority;
  profileId: typeof PROFILE_ID;
  profileEpoch: number;
  interactionId: string;
  interactionRevision: number;
  decision?: "done" | "cancel";
  sessionTransfer?: Readonly<{
    schemaVersion: 1;
    algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1";
    capabilityId: string;
    clientPublicKey: string;
    iv: string;
    ciphertext: string;
  }>;
}>;

export type ProfileResetEnvelope = Readonly<{
  schemaVersion: 1;
  authority: OwnerAuthority;
  requestId: string;
  profileId: typeof PROFILE_ID;
}>;

export type OwnerPurgeEnvelope = Readonly<{
  schemaVersion: 1;
  ownerId: string;
  requestId: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._~:-]{1,512}$/u;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("bad_request", 400);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new GatewayError("bad_request", 400);
  }
};

const boundedString = (value: unknown, maxLength = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const safeIdentityPart = (value: unknown): value is string =>
  boundedString(value) && SAFE_ID_PATTERN.test(value);

const safeInteger = (value: unknown, minimum = 1): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;

const parseAuthority = (value: unknown): TurnAuthority => {
  const authority = record(value);
  exactKeys(authority, [
    "ownerId",
    "ownerGeneration",
    "conversationId",
    "threadId",
    "turnId",
    "attemptGeneration",
  ]);
  if (
    !boundedString(authority.ownerId) ||
    !safeIdentityPart(authority.ownerGeneration) ||
    !safeIdentityPart(authority.conversationId) ||
    !safeIdentityPart(authority.threadId) ||
    !safeIdentityPart(authority.turnId) ||
    !safeInteger(authority.attemptGeneration)
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return authority as TurnAuthority;
};

const parseOwnerAuthority = (value: unknown): OwnerAuthority => {
  const authority = record(value);
  exactKeys(authority, ["ownerId", "ownerGeneration"]);
  if (
    !boundedString(authority.ownerId) ||
    !safeIdentityPart(authority.ownerGeneration)
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return authority as OwnerAuthority;
};

const parseProfileId = (value: unknown): typeof PROFILE_ID => {
  if (value !== PROFILE_ID) throw new GatewayError("bad_request", 400);
  return PROFILE_ID;
};

const parseRequestId = (value: unknown): string => {
  if (!boundedString(value, 128) || !UUID_PATTERN.test(value)) {
    throw new GatewayError("bad_request", 400);
  }
  return value;
};

const parseInteractionId = (value: unknown): string => {
  if (!boundedString(value, 128) || !UUID_PATTERN.test(value)) {
    throw new GatewayError("bad_request", 400);
  }
  return value;
};

export const parseTurnCommand = (value: unknown): TurnCommandEnvelope => {
  const envelope = record(value);
  exactKeys(envelope, ["schemaVersion", "authority", "command"]);
  if (envelope.schemaVersion !== 1) {
    throw new GatewayError("bad_request", 400);
  }
  const authority = parseAuthority(envelope.authority);
  const command = record(envelope.command);
  exactKeys(command, ["schemaVersion", "requestId", "action", "params"]);
  if (
    command.schemaVersion !== 1 ||
    !TURN_ACTIONS.includes(command.action as TurnAction)
  ) {
    throw new GatewayError(
      TURN_ACTIONS.includes(command.action as TurnAction)
        ? "bad_request"
        : "unsupported_action",
      400,
    );
  }
  const params = record(command.params);
  return {
    schemaVersion: 1,
    authority,
    command: {
      schemaVersion: 1,
      requestId: parseRequestId(command.requestId),
      action: command.action as TurnAction,
      params,
    },
  };
};

export const parseInteraction = (
  value: unknown,
  options: Readonly<{
    requireDecision?: boolean;
    allowSessionTransfer?: boolean;
    requireSessionTransfer?: boolean;
  }> = {},
): InteractionEnvelope => {
  const envelope = record(value);
  exactKeys(
    envelope,
    [
      "schemaVersion",
      "authority",
      "profileId",
      "profileEpoch",
      "interactionId",
      "interactionRevision",
      ...(options.requireDecision ? ["decision"] : []),
      ...(options.requireSessionTransfer ? ["sessionTransfer"] : []),
    ],
    [
      ...(options.requireDecision ? [] : ["decision"]),
      ...(options.allowSessionTransfer && !options.requireSessionTransfer
        ? ["sessionTransfer"]
        : []),
    ],
  );
  if (
    envelope.schemaVersion !== 1 ||
    !safeInteger(envelope.profileEpoch) ||
    !safeInteger(envelope.interactionRevision) ||
    (envelope.decision !== undefined &&
      envelope.decision !== "done" &&
      envelope.decision !== "cancel")
  ) {
    throw new GatewayError("bad_request", 400);
  }
  let sessionTransfer: InteractionEnvelope["sessionTransfer"];
  if (envelope.sessionTransfer !== undefined) {
    if (!options.allowSessionTransfer && !options.requireSessionTransfer) {
      throw new GatewayError("bad_request", 400);
    }
    const transfer = record(envelope.sessionTransfer);
    exactKeys(transfer, [
      "schemaVersion",
      "algorithm",
      "capabilityId",
      "clientPublicKey",
      "iv",
      "ciphertext",
    ]);
    if (
      transfer.schemaVersion !== 1 ||
      transfer.algorithm !== "x25519-hkdf-sha256-aes-256-gcm-v1" ||
      !safeIdentityPart(transfer.capabilityId) ||
      !boundedString(transfer.clientPublicKey, 128) ||
      !boundedString(transfer.iv, 64) ||
      !boundedString(transfer.ciphertext, 48 * 1024)
    ) {
      throw new GatewayError("bad_request", 400);
    }
    sessionTransfer = transfer as InteractionEnvelope["sessionTransfer"];
  }
  if (
    sessionTransfer &&
    !options.requireSessionTransfer &&
    envelope.decision !== "done"
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return {
    schemaVersion: 1,
    authority: parseAuthority(envelope.authority),
    profileId: parseProfileId(envelope.profileId),
    profileEpoch: envelope.profileEpoch,
    interactionId: parseInteractionId(envelope.interactionId),
    interactionRevision: envelope.interactionRevision,
    ...(envelope.decision
      ? { decision: envelope.decision as "done" | "cancel" }
      : {}),
    ...(sessionTransfer ? { sessionTransfer } : {}),
  };
};

export const parseProfileReset = (value: unknown): ProfileResetEnvelope => {
  const envelope = record(value);
  exactKeys(envelope, ["schemaVersion", "authority", "requestId", "profileId"]);
  if (envelope.schemaVersion !== 1) {
    throw new GatewayError("bad_request", 400);
  }
  return {
    schemaVersion: 1,
    authority: parseOwnerAuthority(envelope.authority),
    requestId: parseRequestId(envelope.requestId),
    profileId: parseProfileId(envelope.profileId),
  };
};

export const parseOwnerPurge = (value: unknown): OwnerPurgeEnvelope => {
  const envelope = record(value);
  exactKeys(envelope, ["schemaVersion", "ownerId", "requestId"]);
  if (envelope.schemaVersion !== 1 || !boundedString(envelope.ownerId)) {
    throw new GatewayError("bad_request", 400);
  }
  return {
    schemaVersion: 1,
    ownerId: envelope.ownerId,
    requestId: parseRequestId(envelope.requestId),
  };
};

export const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
};

export const sha256Hex = async (
  value: string | Uint8Array,
): Promise<string> => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export const profileObjectName = async (
  ownerId: string,
  profileId: string,
): Promise<string> =>
  sha256Hex(`stella-browser-profile\u0000${ownerId}\u0000${profileId}`);

export const ownerDigest = (ownerId: string): Promise<string> =>
  sha256Hex(`stella-browser-owner\u0000${ownerId}`);

export const generationDigest = (ownerGeneration: string): Promise<string> =>
  sha256Hex(`stella-browser-owner-generation\u0000${ownerGeneration}`);

export const profileDigest = (profileId: string): Promise<string> =>
  sha256Hex(`stella-browser-profile-id\u0000${profileId}`);

export const jsonNoStore = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
