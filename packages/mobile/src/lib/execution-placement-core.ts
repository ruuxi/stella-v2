import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  PLACEMENT_PROTOCOL,
  type DispatchPayload,
  type DispatchSubmitRequest,
} from "@stella/contracts/turn-plane/placement";
import {
  buildMobilePairingChallenge,
  canonicalDispatchPayloadJson,
} from "@stella/contracts/turn-plane/pairing-proof";

export type AutomaticExecutionKind = "chat" | "agent";
export type AutomaticExecutionSubject = "portable" | "computer" | "cloud";
export type AutomaticExecutionTarget =
  | { mode: "automatic" }
  | { mode: "cloud" }
  | { mode: "device"; deviceId: string };
export const AUTOMATIC_EXECUTION_TARGET: AutomaticExecutionTarget =
  Object.freeze({ mode: "automatic" });
export type AutomaticExecutionCapability =
  | "chat"
  | "agent"
  | "computer-use"
  | "local-files"
  | "local-apps"
  | "attachments";

export type AutomaticExecutionStatusSnapshot = {
  dispatchId: string;
  state: string;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: string;
};

const EXECUTION_STATES = new Set([
  "offering",
  "computer_claimed",
  "computer_accepted",
  "computer_running",
  "cloud_committed",
  "cloud_running",
  "cancel_pending",
  "reconciliation_required",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);

const readOptionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 128 * 1024) {
    throw new Error("Execution status returned malformed data.");
  }
  return value;
};

/** Runtime validation for untrusted HTTP/Convex snapshots. */
export const readAutomaticExecutionDispatch = (
  value: unknown,
  expected?: { idempotencyKey?: string; dispatchId?: string },
) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Execution status returned malformed data.");
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    "dispatchId",
    "idempotencyKey",
    "kind",
    "ingress",
    "subject",
    "conversationId",
    "state",
  ] as const;
  for (const key of requiredStrings) {
    if (
      typeof record[key] !== "string" ||
      !(record[key] as string).trim() ||
      (record[key] as string).length > 512
    ) {
      throw new Error("Execution status returned malformed data.");
    }
  }
  if (
    record.ingress !== "mobile" ||
    (record.kind !== "chat" && record.kind !== "agent") ||
    !["portable", "computer", "cloud"].includes(record.subject as string) ||
    !EXECUTION_STATES.has(record.state as string) ||
    (record.placement !== undefined &&
      record.placement !== "computer" &&
      record.placement !== "cloud") ||
    !Number.isSafeInteger(record.revision) ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    (record.terminalAt !== undefined &&
      (typeof record.terminalAt !== "number" ||
        !Number.isFinite(record.terminalAt)))
  ) {
    throw new Error("Execution status returned malformed data.");
  }
  if (
    expected?.idempotencyKey !== undefined &&
    record.idempotencyKey !== expected.idempotencyKey
  ) {
    throw new Error(
      "Execution admission returned a different message identity.",
    );
  }
  if (
    expected?.dispatchId !== undefined &&
    record.dispatchId !== expected.dispatchId
  ) {
    throw new Error("Execution status returned a different dispatch identity.");
  }
  return {
    dispatchId: record.dispatchId as string,
    idempotencyKey: record.idempotencyKey as string,
    kind: record.kind as AutomaticExecutionKind,
    ingress: "mobile" as const,
    subject: record.subject as AutomaticExecutionSubject,
    conversationId: record.conversationId as string,
    state: record.state as string,
    revision: record.revision as number,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
    ...(record.placement === "computer" || record.placement === "cloud"
      ? { placement: record.placement }
      : {}),
    ...Object.fromEntries(
      [
        "parentTurnId",
        "threadId",
        "executorDeviceId",
        "executorPresenceSessionId",
        "fallbackReason",
        "cancelRequestId",
        "cancelReason",
        "errorCode",
        "errorMessage",
        "resultJson",
        "cloudTurnId",
      ]
        .map((key) => [key, readOptionalString(record, key)] as const)
        .filter((entry): entry is readonly [string, string] =>
          Boolean(entry[1]),
        ),
    ),
    ...(typeof record.terminalAt === "number" &&
    Number.isFinite(record.terminalAt)
      ? { terminalAt: record.terminalAt }
      : {}),
  };
};

export type AutomaticExecutionTurnControl = {
  clientIdempotencyKey: string;
  serverDispatchId?: string;
  cancelRequestId?: string;
};

export const bindAutomaticExecutionAdmission = (
  control: AutomaticExecutionTurnControl,
  dispatch: { dispatchId: string; idempotencyKey: string },
): AutomaticExecutionTurnControl => {
  if (dispatch.idempotencyKey !== control.clientIdempotencyKey) {
    throw new Error(
      "Execution admission returned a different message identity.",
    );
  }
  if (
    control.serverDispatchId &&
    control.serverDispatchId !== dispatch.dispatchId
  ) {
    throw new Error(
      "Execution admission replay returned a different dispatch.",
    );
  }
  return { ...control, serverDispatchId: dispatch.dispatchId };
};

export const requestAutomaticExecutionCancellation = (
  control: AutomaticExecutionTurnControl,
): AutomaticExecutionTurnControl => ({
  ...control,
  cancelRequestId:
    control.cancelRequestId ?? `cancel:${control.clientIdempotencyKey}`,
});

export const automaticExecutionCancellationCommand = (
  control: AutomaticExecutionTurnControl,
): { dispatchId: string; cancelRequestId: string } | null =>
  control.serverDispatchId && control.cancelRequestId
    ? {
        dispatchId: control.serverDispatchId,
        cancelRequestId: control.cancelRequestId,
      }
    : null;

/** A rejected/stale grant is a pre-admission eligibility miss, not an outage. */
export const isAutomaticExecutionPairCredentialRejection = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /not paired|paired phone|pair proof|pairing credential|phone credential|desktop grant/i.test(
    message,
  );
};

export const automaticExecutionConversationClientCreateId = (
  threadId: string,
): string => {
  const normalized = threadId.trim().replace(/[^A-Za-z0-9._:-]/g, "-");
  return `mobile-placement:${normalized}`.slice(0, 128);
};

const TERMINAL_EXECUTION_STATES = new Set([
  "completed",
  "failed",
  "canceled",
  "blocked",
]);

export const isAutomaticExecutionTerminal = (
  dispatch: AutomaticExecutionStatusSnapshot,
) => TERMINAL_EXECUTION_STATES.has(dispatch.state);

export class AutomaticExecutionWaitAbortedError extends Error {
  constructor() {
    super("Automatic execution wait was canceled.");
    this.name = "AbortError";
  }
}

const waitForDelay = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AutomaticExecutionWaitAbortedError());
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(new AutomaticExecutionWaitAbortedError()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Pure reconnect loop; callers inject the authenticated status reader. */
export const waitForAutomaticExecutionStatus = async <
  T extends AutomaticExecutionStatusSnapshot,
>(args: {
  dispatchId: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onUpdate?: (dispatch: T) => void;
  beforeRead?: () => Promise<void>;
  readStatus: (dispatchId: string) => Promise<T | null>;
}): Promise<T> => {
  const pollIntervalMs = Math.max(100, args.pollIntervalMs ?? 750);
  for (;;) {
    if (args.signal?.aborted) throw new AutomaticExecutionWaitAbortedError();
    try {
      // A stop can arrive after admission while this observer is already
      // polling. Give the caller a chance to replay the same durable,
      // idempotent cancel request before every bounded read. Transient cancel
      // failures are retried by this loop; they never authorize another
      // executor or placement fallback.
      await args.beforeRead?.();
      const dispatch = await args.readStatus(args.dispatchId);
      if (!dispatch) {
        throw new Error(
          "This execution is no longer available for the signed-in account.",
        );
      }
      args.onUpdate?.(dispatch);
      if (isAutomaticExecutionTerminal(dispatch)) return dispatch;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /no longer available|ownership_migrated|authentication required|signed-in account|linked to (?:an|another) account|being linked|owner generation|account data is currently|malformed|different (?:dispatch|message) identity|invalid response/i.test(
          message,
        )
      ) {
        throw error;
      }
    }
    await waitForDelay(pollIntervalMs, args.signal);
  }
};

export const automaticExecutionResultText = (
  dispatch: AutomaticExecutionStatusSnapshot,
): string => {
  if (dispatch.state === "canceled") return "Stopped.";
  if (dispatch.state === "failed" || dispatch.state === "blocked") {
    return (
      dispatch.errorMessage?.trim() ||
      (dispatch.errorCode === "COMPUTER_REQUIRED_UNAVAILABLE"
        ? "No eligible paired computer is online for this computer-only request."
        : "Stella couldn't complete this request. Try again.")
    );
  }
  const raw = dispatch.resultJson?.trim();
  if (!raw) return "Done.";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const finalText = (parsed as { finalText?: unknown }).finalText;
      if (typeof finalText === "string" && finalText.trim()) {
        return finalText.trim();
      }
    }
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  } catch {
    return raw;
  }
  return "Done.";
};

export type AutomaticExecutionAdmissionInput = {
  /** Persisted opt-in so pre-upgrade outbox retries keep their original hash. */
  userMessageEventId?: string;
  idempotencyKey: string;
  conversationId: string;
  kind: AutomaticExecutionKind;
  prompt: string;
  description?: string;
  parentTurnId?: string;
  threadId?: string;
  /** What the work is about, never which executor runs it. */
  subject?: AutomaticExecutionSubject;
  /** Which executor runs it, independent of subject. */
  target?: AutomaticExecutionTarget;
  /** Exact cloud model chosen when this durable send was created. */
  execution?: CloudExecutionSelection;
  requiredCapabilities?: AutomaticExecutionCapability[];
  /**
   * Drive-relative paths of files already uploaded for this turn. References
   * only: bytes would blow the envelope's 128 KB ceiling, and the placement
   * service resolves a path on either placement.
   */
  attachments?: readonly string[];
};

/** Mirrors the server's cap so a turn is never admitted and then truncated. */
export const AUTOMATIC_EXECUTION_MAX_ATTACHMENTS = 4;

const validAttachmentPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 400 &&
  !path.startsWith("/") &&
  !/^[a-zA-Z]:/.test(path) &&
  !path.includes("\\") &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(path) &&
  path
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

export const buildAutomaticExecutionAdmission = (
  input: AutomaticExecutionAdmissionInput,
) => {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("A prompt is required.");
  const idempotencyKey = input.idempotencyKey.trim();
  const conversationId = input.conversationId.trim();
  const subject = input.subject ?? "portable";
  const target = input.target ?? AUTOMATIC_EXECUTION_TARGET;
  const targetDeviceId = target.mode === "device" ? target.deviceId.trim() : "";
  if (target.mode === "device" && !targetDeviceId) {
    throw new Error("A selected computer needs a device id.");
  }
  const attachments = [...new Set(input.attachments ?? [])];
  if (attachments.length > AUTOMATIC_EXECUTION_MAX_ATTACHMENTS) {
    throw new Error(
      `A turn may carry at most ${AUTOMATIC_EXECUTION_MAX_ATTACHMENTS} attachments.`,
    );
  }
  if (!attachments.every(validAttachmentPath)) {
    throw new Error("An attachment does not name a drive file.");
  }
  // Exactly the bytes an executing device receives. The builder re-derives
  // this string from the parsed payload with the same contract helper, so the
  // hash the pair proof commits to is reproducible on both sides.
  const payload: DispatchPayload = {
    schemaVersion: 1,
    prompt,
    conversationId,
    clientMsgId: idempotencyKey,
    // Echo the UI identity in the journal even when it beats admission back.
    ...(input.userMessageEventId ? { userMessageEventId: input.userMessageEventId } : {}),
    ...(input.execution && input.target?.mode !== "device" ? { execution: input.execution } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(input.kind === "agent"
      ? { description: input.description?.trim() || prompt.slice(0, 160) }
      : {}),
  };
  const payloadJson = canonicalDispatchPayloadJson(payload);
  // The contract's `dispatchPayloadHash` is WebCrypto; React Native has no
  // `crypto.subtle`, so the same digest is taken with @noble over the same
  // canonical bytes.
  const payloadHash = bytesToHex(sha256(utf8ToBytes(payloadJson)));
  const challenge = buildMobilePairingChallenge({
    idempotencyKey,
    conversationId,
    payloadHash,
    kind: input.kind,
    subject,
    targetMode: target.mode,
    targetDeviceId,
  });
  const body: DispatchSubmitRequest = {
    protocol: PLACEMENT_PROTOCOL,
    idempotencyKey,
    kind: input.kind,
    ingress: "mobile",
    subject,
    targetMode: target.mode,
    ...(targetDeviceId ? { targetDeviceId } : {}),
    conversationId,
    ...(input.parentTurnId?.trim()
      ? { parentTurnId: input.parentTurnId.trim() }
      : {}),
    ...(input.threadId?.trim() ? { threadId: input.threadId.trim() } : {}),
    requiredCapabilities: [
      ...new Set([input.kind, ...(input.requiredCapabilities ?? [])]),
    ],
    payload,
  };
  return { challenge, payloadJson, payloadHash, body };
};
