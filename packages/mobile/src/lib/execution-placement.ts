import {
  DEVICES_PATH,
  PLACEMENT_PROTOCOL,
  dispatchCancelPath,
  dispatchPath,
  DISPATCH_SUBMIT_PATH,
  type DeviceDestination,
} from "@stella/contracts/turn-plane/placement";
import { phonePairingProofHeaders } from "./phone-pair-proof";
import { getJson, postJson } from "./http";
import { ensurePhoneAccess, type StoredPhoneAccess } from "./phone-access";
import { env } from "../config/env";
import { getBackendClient } from "./backend";
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
  /** Overrides the backend origin from `EXPO_PUBLIC_STELLA_BACKEND_URL`. */
  builderOrigin?: string | null;
};


const EXECUTION_PLACEMENT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  sign_in_required: "Sign in to Stella to use cloud agents.",
  subscription_required: "Running in the cloud needs a Stella subscription.",
  owner_suspended: "This account can't use Stella's cloud right now.",
};

/**
 * Replace the server's terse message for the codes above. The error is the
 * `HttpRequestError` the http helper just built for this request, so its
 * message is rewritten in place (status and code stay) rather than re-created,
 * which keeps this module free of the class import test harnesses mock out.
 */
const mapExecutionPlacementError = (error: unknown): unknown => {
  if (!(error instanceof Error)) return error;
  const code = Reflect.get(error, "code");
  if (typeof code !== "string") return error;
  const message = EXECUTION_PLACEMENT_ERROR_MESSAGES[code];
  if (message) error.message = message;
  return error;
};

const executionPlacementRequest = async <T>(
  request: Promise<T>,
): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw mapExecutionPlacementError(error);
  }
};

/**
 * The backend worker's origin. Placement lives in the per-owner Durable
 * Object there; the origin is build-time config.
 */
export const resolveExecutionBuilderOrigin = async (
  override?: string | null,
): Promise<string> => {
  const explicit = override?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  if (!/^https?:\/\//.test(env.backendUrl)) {
    throw new Error("Stella's cloud isn't configured in this build.");
  }
  return env.backendUrl;
};

/**
 * A dispatch the gate no longer owns. Read structurally rather than through
 * the error class so any transport that reports a status can answer it.
 */
const isMissingDispatch = (error: unknown): boolean => {
  const detail = error as { status?: unknown; code?: unknown } | null;
  return detail?.status === 404 || detail?.code === "not_found";
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
 * Creates (or replays) the owner's conversation used by a mobile surface, for
 * connected and anonymous owners alike. A client key, rather than a cached
 * server UUID, makes a lost mutation response and an app restart safe without
 * ever creating two cloud conversation identities for one surface.
 */
export const ensureAutomaticExecutionConversation = async (args: {
  threadId: string;
  title: string;
}): Promise<string> => {
  // `owner.identity` is open to anonymous owners: hosted chat needs no account.
  const identity = await getBackendClient().call("owner.identity", {});
  const expectedOwnerGeneration = identity.ownerGeneration.trim();
  if (!expectedOwnerGeneration) {
    throw new Error(
      "Conversation admission could not establish owner authority.",
    );
  }
  return await createAutomaticExecutionConversation({
    ...args,
    expectedOwnerGeneration,
  });
};

/**
 * `ensureAutomaticExecutionConversation` for a caller that already holds the
 * owner generation (the chat bootstrap read), saving its identity round trip.
 */
export const createAutomaticExecutionConversation = async (args: {
  threadId: string;
  title: string;
  expectedOwnerGeneration: string;
}): Promise<string> => {
  const conversation = await getBackendClient().call("conversations.create", {
    clientCreateId: automaticExecutionConversationClientCreateId(args.threadId),
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
  const value = await executionPlacementRequest(
    getJson(DEVICES_PATH, {
      origin,
      signal: options?.signal,
      timeoutMs: 10_000,
    }),
  );
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
    value = await executionPlacementRequest(
      getJson(dispatchPath(normalized), {
        origin,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? 10_000,
      }),
    );
  } catch (error) {
    // A dispatch the gate no longer owns is a definitive answer, not an
    // outage: the observer must stop rather than poll a missing row forever.
    if (isMissingDispatch(error)) return null;
    throw error;
  }
  return value === null
    ? null
    : readDispatchEnvelope(value, {
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
  const value = await executionPlacementRequest(
    postJson(
      dispatchCancelPath(dispatchId),
      {
        protocol: PLACEMENT_PROTOCOL,
        cancelRequestId: args.cancelRequestId.trim(),
        ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
      },
      { origin, signal: args.signal, timeoutMs: 10_000 },
    ),
  );
  return readDispatchEnvelope(value, { dispatchId });
};

/**
 * Reconnectable terminal observer. Backend reads are snapshots here instead
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
  // A named computer the phone holds no credential for is attached here rather
  // than refused: the pair secret is this proof's key, not permission to run.
  // Whether that computer accepts the work is its own remote-execution state,
  // which the gate answers for — attaching never moves it.
  const deviceAccess =
    target.mode === "device" &&
    (!access || access.desktopDeviceId !== target.deviceId.trim())
      ? await ensurePhoneAccess(target.deviceId)
      : access;
  const pairedAccess = target.mode === "cloud" ? undefined : deviceAccess;
  // Unchanged proof scheme, now addressed to the builder: HMAC-SHA256 keyed by
  // sha256hex(pairSecret) over the same message, in the contract's header set.
  // The HMAC itself stays on @noble because React Native has no WebCrypto.
  const pairHeaders = pairedAccess
    ? phonePairingProofHeaders(pairedAccess, admission.challenge)
    : undefined;
  const origin = await resolveExecutionBuilderOrigin(builderOrigin);
  const result = await executionPlacementRequest(
    postJson(
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
    ),
  );
  return readDispatchEnvelope(result, {
    idempotencyKey: admission.body.idempotencyKey,
  });
};
