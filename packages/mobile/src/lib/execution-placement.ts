import { makeFunctionReference } from "convex/server";
import { getJson, postJson } from "./http";
import {
  buildPhonePairProofHeaders,
  type StoredPhoneAccess,
} from "./phone-access";
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

export const getAutomaticExecutionStatus = async (
  dispatchId: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<AutomaticExecutionDispatch | null> => {
  const normalized = dispatchId.trim();
  const value = await getJson(
    `/api/mobile/execution/status?dispatchId=${encodeURIComponent(normalized)}`,
    { signal: options?.signal, timeoutMs: options?.timeoutMs ?? 10_000 },
  );
  return value === null
    ? null
    : (readAutomaticExecutionDispatch(value, {
        dispatchId: normalized,
      }) as AutomaticExecutionDispatch);
};

export const cancelAutomaticExecution = async (args: {
  dispatchId: string;
  cancelRequestId: string;
  reason?: string;
  signal?: AbortSignal;
}): Promise<AutomaticExecutionDispatch> => {
  const value = await postJson(
    "/api/mobile/execution/cancel",
    {
      dispatchId: args.dispatchId.trim(),
      cancelRequestId: args.cancelRequestId.trim(),
      ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    },
    { signal: args.signal, timeoutMs: 10_000 },
  );
  return readAutomaticExecutionDispatch(value, {
    dispatchId: args.dispatchId.trim(),
  }) as AutomaticExecutionDispatch;
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
  onUpdate?: (dispatch: AutomaticExecutionDispatch) => void;
  beforeRead?: () => Promise<void>;
  readStatus?: (
    dispatchId: string,
  ) => Promise<AutomaticExecutionDispatch | null>;
}): Promise<AutomaticExecutionDispatch> => {
  const readStatus =
    args.readStatus ??
    ((dispatchId: string) =>
      getAutomaticExecutionStatus(dispatchId, { signal: args.signal }));
  return await waitForAutomaticExecutionStatus({
    ...args,
    readStatus,
  });
};

export const submitAutomaticExecution = async (
  input: SubmitAutomaticExecutionInput,
): Promise<AutomaticExecutionDispatch> => {
  const { access, ...admissionInput } = input;
  const admission = buildAutomaticExecutionAdmission(admissionInput);
  const target = admissionInput.target ?? AUTOMATIC_EXECUTION_TARGET;
  if (
    target.mode === "device" &&
    (!access || access.desktopDeviceId !== target.deviceId.trim())
  ) {
    throw new Error("The selected computer is not paired with this phone.");
  }
  const pairedAccess = target.mode === "cloud" ? undefined : access;
  const pairHeaders = pairedAccess
    ? buildPhonePairProofHeaders(pairedAccess, admission.challenge)
    : undefined;
  const result = await postJson(
    "/api/mobile/execution/submit",
    {
      ...admission.body,
      ...(pairedAccess
        ? { desktopDeviceId: pairedAccess.desktopDeviceId }
        : {}),
    },
    pairHeaders ? { headers: pairHeaders } : undefined,
  );
  if (!result || typeof result !== "object") {
    throw new Error("Execution admission returned an invalid response.");
  }
  return readAutomaticExecutionDispatch(result, {
    idempotencyKey: admission.body.idempotencyKey,
  }) as AutomaticExecutionDispatch;
};
