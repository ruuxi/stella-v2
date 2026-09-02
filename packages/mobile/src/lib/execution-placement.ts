import { makeFunctionReference } from "convex/server";
import {
  DEVICES_PATH,
  PLACEMENT_PROTOCOL,
  dispatchCancelPath,
  dispatchPath,
  DISPATCH_SUBMIT_PATH,
  type DeviceDestination,
} from "@stella/contracts/turn-plane/placement";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  buildMobilePairingProofMessage,
  mobilePairingProofHeaders,
} from "@stella/contracts/turn-plane/pairing-proof";
import { getJson, postJson } from "./http";
import { type StoredPhoneAccess } from "./phone-access";
import { getConvexClient } from "./convex";
import {
  AUTOMATIC_EXECUTION_TARGET,
  buildAutomaticExecutionAdmission,
  automaticExecutionConversationClientCreateId,
  readAutomaticExecutionDispatch,
  waitForAutomaticExecutionStatus,
  type AutomaticExecutionAdmissionInput,
  type AutomaticExecutionKind,
  type AutomaticExecutionSubject,
} from "./execution-placement-core";
export {
  AUTOMATIC_EXECUTION_TARGET,
  AutomaticExecutionWaitAbortedError,
  automaticExecutionCancellationCommand,
  automaticExecutionResultText,
  automaticExecutionConversationClientCreateId,
  bindAutomaticExecutionAdmission,
  buildAutomaticExecutionAdmission,
  isAutomaticExecutionTerminal,
  isAutomaticExecutionPairCredentialRejection,
  requestAutomaticExecutionCancellation,
} from "./execution-placement-core";
export type {
  AutomaticExecutionCapability,
  AutomaticExecutionKind,
  AutomaticExecutionSubject,
  AutomaticExecutionTarget,
  AutomaticExecutionTurnControl,
} from "./execution-placement-core";

export type AutomaticExecutionDispatch = {
  dispatchId: string;
  idempotencyKey: string;
  kind: AutomaticExecutionKind;
  ingress: "mobile";
  subject: AutomaticExecutionSubject;
  conversationId: string;
  parentTurnId?: string;
  threadId?: string;
  state: string;
  placement?: "computer" | "cloud";
  executorDeviceId?: string;
  executorPresenceSessionId?: string;
  revision: number;
  fallbackReason?: string;
  cancelRequestId?: string;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: string;
  cloudTurnId?: string;
  terminalAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type SubmitAutomaticExecutionInput = AutomaticExecutionAdmissionInput & {
  access?: StoredPhoneAccess;
  /** Overrides the cached `getCloudRealtimeConfig().socketOrigin`. */
  builderOrigin?: string | null;
};

type CloudConversationProjection = {
  conversationId: string;
};

const createConversationRef = makeFunctionReference<
  "mutation",
  {
    clientCreateId: string;
    expectedOwnerGeneration: string;
    title?: string;
  },
  CloudConversationProjection
>("cloud_apps:createMyConversation");

const placementIdentityRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { ownerGeneration: string }
>("execution_placement:getMyExecutionPlacementIdentity");

const realtimeConfigRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { socketOrigin?: string | null }
>("cloud_apps:getCloudRealtimeConfig");

/**
 * The cloud builder's public origin. Placement lives in the per-owner Durable
 * Object there, so every dispatch route is on this origin rather than Convex.
 * It never changes for a deployment, so one resolution per app run is enough.
 */
let cachedBuilderOrigin: string | null = null;

export const resolveExecutionBuilderOrigin = async (
  override?: string | null,
): Promise<string> => {
  const explicit = override?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  if (cachedBuilderOrigin) return cachedBuilderOrigin;
  const config = await getConvexClient().query(realtimeConfigRef, {});
  const origin =
    typeof config?.socketOrigin === "string"
      ? config.socketOrigin.trim().replace(/\/+$/, "")
      : "";
  if (!/^https?:\/\//.test(origin)) {
    throw new Error("Stella's cloud isn't reachable yet. Try again shortly.");
  }
  cachedBuilderOrigin = origin;
  return origin;
};

/**
 * A dispatch the gate no longer owns. Read structurally rather than through
 * the error class so any transport that reports a status can answer it.
 */
const isMissingDispatch = (error: unknown): boolean => {
  const detail = error as { status?: unknown; code?: unknown } | null;
  return detail?.status === 404 || detail?.code === "not_found";
};

/**
 * The pairing proof for a placement submit, in the contract's exact scheme:
 * HMAC-SHA256 keyed by the lowercase-hex sha256 of the pairing secret over
 * the contract's message. The digest is @noble rather than the contract's own
 * WebCrypto signer because React Native has no `crypto.subtle`.
 */
const signPlacementPairingProof = (
  access: StoredPhoneAccess,
  challenge: string,
): { issuedAt: number; proof: string } => {
  const issuedAt = Date.now();
  const pairingKey = bytesToHex(sha256(utf8ToBytes(access.pairSecret)));
  return {
    issuedAt,
    proof: bytesToHex(
      hmac(
        sha256,
        utf8ToBytes(pairingKey),
        utf8ToBytes(
          buildMobilePairingProofMessage({
            desktopDeviceId: access.desktopDeviceId,
            mobileDeviceId: access.mobileDeviceId,
            challenge,
            issuedAt,
          }),
        ),
      ),
    ),
  };
};

/** The gate answers `{ protocol, dispatch, replayed? }`. */
const readDispatchEnvelope = (
  value: unknown,
  expected?: { idempotencyKey?: string; dispatchId?: string },
) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Execution status returned malformed data.");
  }
  return readAutomaticExecutionDispatch(
    (value as { dispatch?: unknown }).dispatch,
    expected,
  ) as AutomaticExecutionDispatch;
};

/**
 * Creates (or replays) the account-owned conversation used by a mobile
 * surface. A client key, rather than a cached server UUID, makes a lost
 * mutation response and an app restart safe without ever creating two cloud
 * conversation identities for one surface.
 */
export const ensureAutomaticExecutionConversation = async (args: {
  threadId: string;
  title: string;
}): Promise<string> => {
  const clientCreateId = automaticExecutionConversationClientCreateId(
    args.threadId,
  );
  const client = getConvexClient();
  const identity = await client.query(placementIdentityRef, {});
  const expectedOwnerGeneration = identity?.ownerGeneration?.trim();
  if (!expectedOwnerGeneration) {
    throw new Error(
      "Conversation admission could not establish owner authority.",
    );
  }
  const conversation = await client.mutation(createConversationRef, {
    clientCreateId,
    expectedOwnerGeneration,
    title: args.title.trim().slice(0, 80),
  });
  if (
    !conversation ||
    typeof conversation.conversationId !== "string" ||
    !conversation.conversationId.trim() ||
    conversation.conversationId.length > 256
  ) {
    throw new Error("Conversation admission returned malformed data.");
  }
  return conversation.conversationId.trim();
};

export type ExecutionDeviceDestination = DeviceDestination;

/**
 * The owner's execution destinations with live presence, read from the owner
 * gate. Presence is a socket fact there, so this is a poll, not a
 * subscription: callers refresh it while a picker is on screen.
 */
export const listExecutionDevices = async (options?: {
  signal?: AbortSignal;
  builderOrigin?: string | null;
}): Promise<ExecutionDeviceDestination[]> => {
  const origin = await resolveExecutionBuilderOrigin(options?.builderOrigin);
  const value = await getJson(DEVICES_PATH, {
    origin,
    signal: options?.signal,
    timeoutMs: 10_000,
  });
  const devices =
    value && typeof value === "object"
      ? (value as { devices?: unknown }).devices
      : null;
  if (!Array.isArray(devices)) {
    throw new Error("Execution destinations returned malformed data.");
  }
  return devices.filter(
    (device): device is ExecutionDeviceDestination =>
      Boolean(device) &&
      typeof device === "object" &&
      typeof (device as { deviceId?: unknown }).deviceId === "string",
  );
};

export const getAutomaticExecutionStatus = async (
  dispatchId: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    builderOrigin?: string | null;
  },
): Promise<AutomaticExecutionDispatch | null> => {
  const normalized = dispatchId.trim();
  const origin = await resolveExecutionBuilderOrigin(options?.builderOrigin);
  let value: unknown;
  try {
    value = await getJson(dispatchPath(normalized), {
      origin,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 10_000,
    });
  } catch (error) {
    // A dispatch the gate no longer owns is a definitive answer, not an
    // outage: the observer must stop rather than poll a missing row forever.
    if (isMissingDispatch(error)) return null;
    throw error;
  }
  return value === null ? null : readDispatchEnvelope(value, {
    dispatchId: normalized,
  });
};

export const cancelAutomaticExecution = async (args: {
  dispatchId: string;
  cancelRequestId: string;
  reason?: string;
  signal?: AbortSignal;
  builderOrigin?: string | null;
}): Promise<AutomaticExecutionDispatch> => {
  const dispatchId = args.dispatchId.trim();
  const origin = await resolveExecutionBuilderOrigin(args.builderOrigin);
  const value = await postJson(
    dispatchCancelPath(dispatchId),
    {
      protocol: PLACEMENT_PROTOCOL,
      cancelRequestId: args.cancelRequestId.trim(),
      ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    },
    { origin, signal: args.signal, timeoutMs: 10_000 },
  );
  return readDispatchEnvelope(value, { dispatchId });
};

/**
 * Reconnectable terminal observer. Convex queries are snapshots here instead
 * of a component subscription so the durable outbox can own this lifecycle
 * across hook remounts. Transient read failures keep polling the same committed
 * dispatch; they never authorize a second executor or a transport fallback.
 */
export const waitForAutomaticExecution = async (args: {
  dispatchId: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  builderOrigin?: string | null;
  onUpdate?: (dispatch: AutomaticExecutionDispatch) => void;
  beforeRead?: () => Promise<void>;
  readStatus?: (
    dispatchId: string,
  ) => Promise<AutomaticExecutionDispatch | null>;
}): Promise<AutomaticExecutionDispatch> => {
  const readStatus =
    args.readStatus ??
    ((dispatchId: string) =>
      getAutomaticExecutionStatus(dispatchId, {
        signal: args.signal,
        ...(args.builderOrigin ? { builderOrigin: args.builderOrigin } : {}),
      }));
  return await waitForAutomaticExecutionStatus({
    ...args,
    readStatus,
  });
};

export const submitAutomaticExecution = async (
  input: SubmitAutomaticExecutionInput,
): Promise<AutomaticExecutionDispatch> => {
  const { access, builderOrigin, ...admissionInput } = input;
  const admission = buildAutomaticExecutionAdmission(admissionInput);
  const target = admissionInput.target ?? AUTOMATIC_EXECUTION_TARGET;
  if (
    target.mode === "device" &&
    (!access || access.desktopDeviceId !== target.deviceId.trim())
  ) {
    throw new Error("The selected computer is not paired with this phone.");
  }
  const pairedAccess = target.mode === "cloud" ? undefined : access;
  // Unchanged proof scheme, now addressed to the builder: HMAC-SHA256 keyed by
  // sha256hex(pairSecret) over the same message, in the contract's header set.
  // The HMAC itself stays on @noble because React Native has no WebCrypto.
  const pairHeaders = pairedAccess
    ? mobilePairingProofHeaders({
        mobileDeviceId: pairedAccess.mobileDeviceId,
        desktopDeviceId: pairedAccess.desktopDeviceId,
        challenge: admission.challenge,
        ...signPlacementPairingProof(pairedAccess, admission.challenge),
      })
    : undefined;
  const origin = await resolveExecutionBuilderOrigin(builderOrigin);
  const result = await postJson(
    DISPATCH_SUBMIT_PATH,
    {
      ...admission.body,
      ...(pairedAccess
        ? { requestingDeviceId: pairedAccess.mobileDeviceId }
        : {}),
    },
    {
      origin,
      ...(pairHeaders ? { headers: pairHeaders } : {}),
    },
  );
  return readDispatchEnvelope(result, {
    idempotencyKey: admission.body.idempotencyKey,
  });
};
