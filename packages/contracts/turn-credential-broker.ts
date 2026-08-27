/** Wire contract between a Cloud Builder turn broker and its executor. */
export const TURN_BROKER_VERSION = 1 as const;
export const TURN_BROKER_AUTH_SCHEME = "StellaTurnBroker";
export const TURN_BROKER_TURN_TOKEN_HEADER = "x-stella-turn-token";
export const TURN_BROKER_TURN_STATE_CHECKPOINT_PATH =
  "/internal/stella/turn/state-checkpoint";
/** @deprecated Use the atomic workspace + native turn-state checkpoint path. */
export const TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH =
  TURN_BROKER_TURN_STATE_CHECKPOINT_PATH;

export const TURN_BROKER_HEADERS = {
  ownerId: "x-stella-broker-owner-id",
  ownerGeneration: "x-stella-broker-owner-generation",
  turnId: "x-stella-broker-turn-id",
  attemptGeneration: "x-stella-broker-attempt-generation",
  sequence: "x-stella-broker-sequence",
  requestId: "x-stella-broker-request-id",
  targetPath: "x-stella-broker-target-path",
  targetMethod: "x-stella-broker-target-method",
} as const;

export const TURN_BROKER_RESPONSE_HEADERS = {
  denial: "x-stella-broker-denial",
  replayPending: "x-stella-broker-replay-pending",
} as const;

export type TurnBrokerIdentity = {
  sessionId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  attemptGeneration: number;
};

/**
 * Token-bearing half of the handoff. Builder writes it to a one-shot file;
 * the executor unlinks that file before any model or tool process exists.
 */
export type TurnBrokerHandoff = TurnBrokerIdentity & {
  version: typeof TURN_BROKER_VERSION;
  endpoint: string;
  capability: string;
  expiresAt: number;
  initialSequence: 1;
};

/** The turn input carries only this non-secret pointer. */
export type TurnBrokerInput = {
  credentialsPath: string;
};

export type TurnBrokerNativeStateCheckpoint = {
  engine: "anthropic";
  sessionId: string;
  cursor: string;
  tree: {
    algorithm: "sha256";
    digest: string;
    entries: number;
    bytes: number;
  };
  mac: string;
};

export type TurnBrokerTurnStateCheckpointRequest = {
  schemaVersion: 1;
  historyCursor: string;
  nativeCheckpoint?: TurnBrokerNativeStateCheckpoint;
};

export type TurnBrokerTurnStateCheckpointReceipt = {
  schemaVersion: 1;
  operationId: string;
  historyCursor: string;
  workspaceSha256: string;
  nativeSha256?: string;
  receipt: string;
  replayed: boolean;
};

/** @deprecated Compatibility alias for pre-atomic callers. */
export type TurnBrokerNativeStateCheckpointRequest =
  TurnBrokerTurnStateCheckpointRequest;
/** @deprecated Compatibility alias for pre-atomic callers. */
export type TurnBrokerNativeStateCheckpointReceipt =
  TurnBrokerTurnStateCheckpointReceipt;
