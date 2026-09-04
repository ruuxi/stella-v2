/** Wire contract between a Cloud Builder turn broker and its executor. */
export const TURN_BROKER_VERSION = 1 as const;
export const TURN_BROKER_AUTH_SCHEME = "StellaTurnBroker";
export const TURN_BROKER_TURN_TOKEN_HEADER = "x-stella-turn-token";
export const TURN_BROKER_TURN_STATE_CHECKPOINT_PATH =
  "/internal/stella/turn/state-checkpoint";
/** @deprecated Use the atomic workspace + native turn-state checkpoint path. */
export const TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH =
  TURN_BROKER_TURN_STATE_CHECKPOINT_PATH;
export const TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH =
  "/internal/stella/turn/interior-build-request";

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

/**
 * A Stella-interior turn asking Builder to run the production interior build
 * after it finishes. Builder records the request; nothing about the artifact
 * or its activation is decided here.
 */
export type TurnBrokerInteriorBuildRequest = {
  schemaVersion: 1;
  note?: string;
};

export type TurnBrokerInteriorBuildRequestReceipt = {
  schemaVersion: 1;
  requested: true;
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

/**
 * Secret-free provider transcript staged with a suspended turn checkpoint.
 * Builder keeps it only so executor/finalizer loss cannot erase the canonical
 * outer tool-call boundary needed to resume a human browser handoff.
 */
export type TurnBrokerCheckpointTranscriptRow = {
  ordinal: number;
  role: string;
  payloadJson: string;
};

export type TurnBrokerTurnStateCheckpointRequest = {
  schemaVersion: 1;
  historyCursor: string;
  nativeCheckpoint?: TurnBrokerNativeStateCheckpoint;
  suspensionTranscript?: TurnBrokerCheckpointTranscriptRow[];
};

export type TurnBrokerTurnStateCheckpointReceipt = {
  operationId: string;
  historyCursor: string;
  manifestId: string;
};
