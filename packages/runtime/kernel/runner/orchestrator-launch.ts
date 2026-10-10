import {
  runOrchestratorTurn,
  type RuntimeEndEvent,
  type RuntimeErrorEvent,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { RuntimeInterruptedEvent } from "../agent-runtime/types.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import {
  createFileAttachmentPromptInput,
  createRuntimePromptAgentMessage,
  isInlineImageAttachment,
} from "../agent-runtime/run-preparation.js";
import { buildThreadMessagePreview } from "../agent-runtime/thread-memory.js";
import { executionContextHistoryEntries } from "../agent-runtime/execution-context-history.js";
import { hasResidentHead } from "../agent-runtime/resident-context.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
import { renderAgentRoster } from "@stella/contracts/agent-directory";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  resolveAgentModelRoute,
  type BuildAgentContextArgs,
} from "./context.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import { ensureRunCoordinator } from "./run-coordinator.js";
import type { RunnerContext } from "./types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import {
  appendMessageRefTag,
  MESSAGE_REF_TAG_RE,
} from "@stella/contracts/reply-refs";
import { GATEWAY_SIGN_IN_REQUIRED_MESSAGE } from "@stella/contracts/gateway/api";
import { createRuntimeLogger } from "../debug.js";
import {
  CloudTranscriptAlreadyAdmittedError,
  type CloudTranscriptBeginAck,
  type CloudTranscriptHistory,
} from "./cloud-transcript-write.js";

type BuildAgentContext = (
  args: BuildAgentContextArgs,
) => Promise<LocalAgentContext>;

/**
 * Whether this computer supplies Stella's agent list for a turn stored here.
 * A cloud turn's history and compaction live in the conversation's journal,
 * so it reads the list once that history is seeded.
 */
const readsAgentRoster = (args: {
  agentType: string;
  storageMode?: "cloud" | "local";
}): boolean =>
  args.agentType === AGENT_IDS.ORCHESTRATOR && args.storageMode !== "cloud";

const readAgentRoster = async (
  context: RunnerContext,
  conversationId: string,
): Promise<string | undefined> =>
  renderAgentRoster(await context.readConversationAgentRows(conversationId));

type DeferredTerminalCallback =
  | { kind: "end"; event: RuntimeEndEvent }
  | { kind: "error"; event: RuntimeErrorEvent }
  | { kind: "interrupted"; event: RuntimeInterruptedEvent };

/**
 * The user message a local turn mirrors into the cloud journal. A hidden
 * runtime prompt (an agent's `[Agent completed]` wake, a queued-message
 * reply) has no user-typed text: it travels as a `message`-type prompt with
 * an empty `userPrompt`. Mirror that prompt's text, flagged hidden, so every
 * client can read the task it names instead of an empty, visible bubble.
 *
 * Journal visibility is a property of the prompt's authorship, not of the
 * run's UI visibility. A relayed chat message (typed on the phone, executed
 * here) runs hidden on purpose — the sending client owns its presentation and
 * this computer publishes no rows for it — but its journal row is the only
 * copy every other client can read, so `userAuthoredPrompt` keeps that row
 * visible. Without it, every message sent from another device was persisted
 * `hidden = 1` and no desktop or web client could ever render it.
 */
export const buildCloudUserMessage = (
  prepared: Pick<
    PreparedOrchestratorRun,
    | "promptMessages"
    | "userPrompt"
    | "attachments"
    | "agentContext"
    | "uiVisibility"
    | "userAuthoredPrompt"
    | "userMessageMetadata"
  >,
): { message: PersistedRuntimeThreadPayload; hidden: boolean } => {
  const promptMessages = prepared.promptMessages ?? [];
  let promptInput: RuntimePromptMessage & {
    attachments?: RuntimeAttachmentRef[];
  } = {
    text: prepared.userPrompt,
    attachments: prepared.attachments,
  };
  let chosen: RuntimePromptMessage | null = null;
  for (let index = promptMessages.length - 1; index >= 0; index -= 1) {
    const candidate = promptMessages[index]!;
    if ((candidate.messageType ?? "user") !== "user") continue;
    chosen = candidate;
    promptInput = {
      ...candidate,
      ...(index === promptMessages.length - 1 && prepared.attachments.length
        ? { attachments: prepared.attachments }
        : {}),
    };
    break;
  }
  // A turn with no user-typed prompt was started by the runtime itself (a
  // lifecycle wake, a queued-message reply): mirror the runtime prompt's
  // text so clients can read what the turn answers, and mark it hidden —
  // the user never typed it and no client shows it.
  let runtimePrompt = false;
  if (!chosen && !prepared.userPrompt.trim()) {
    const candidate = promptMessages.findLast(
      (entry) => entry.text.trim().length > 0,
    );
    if (candidate) {
      chosen = candidate;
      runtimePrompt = true;
      promptInput = {
        text: candidate.text,
        ...(prepared.attachments.length
          ? { attachments: prepared.attachments }
          : {}),
      };
    }
  }
  const message = createRuntimePromptAgentMessage(promptInput, Date.now());
  if (message.role !== "user") {
    throw new Error("Cloud local turns require a user message.");
  }
  const executionContext = prepared.agentContext.executionContext;
  const fileAttachments = cloudFileAttachmentMetadata(promptInput.attachments);
  // A runtime prompt is never user-authored: it has no typed text at all, so
  // it stays hidden even when the caller claims authorship for the turn.
  // The exception is a send that carried only composer context (a pasted-text
  // chip, a quote): the person did send it, so the row stays visible with an
  // empty display body while its text keeps the context for the model.
  const contextOnlySend = runtimePrompt && Boolean(prepared.userMessageMetadata);
  const userAuthored =
    (prepared.userAuthoredPrompt === true && !runtimePrompt) || contextOnlySend;
  const hidden =
    !userAuthored &&
    (runtimePrompt ||
      prepared.uiVisibility === "hidden" ||
      chosen?.uiVisibility === "hidden");
  return {
    message: {
      ...message,
      ...(executionContext ? { executionContext } : {}),
      ...(fileAttachments.length > 0 ? { attachments: fileAttachments } : {}),
      ...(prepared.userMessageMetadata
        ? {
            metadata: {
              ...prepared.userMessageMetadata,
              ...(contextOnlySend ? { displayText: "" } : {}),
            },
          }
        : {}),
    },
    hidden,
  };
};

/**
 * The prompt `buildCloudUserMessage` journals, tagged with its journal seq
 * (`message #N`) for the model: the last user-typed prompt message, else
 * `userPrompt`. The journal keeps the raw text; the tag rides only what the
 * model reads and the turn's own thread, which a later turn may reuse.
 */
export const withCloudPromptRefTag = (
  prepared: Pick<PreparedOrchestratorRun, "promptMessages" | "userPrompt">,
  sequence: number,
): Partial<Pick<PreparedOrchestratorRun, "promptMessages" | "userPrompt">> => {
  const promptMessages = prepared.promptMessages ?? [];
  const index = promptMessages.findLastIndex(
    (message) => (message.messageType ?? "user") === "user",
  );
  if (index >= 0) {
    return {
      promptMessages: promptMessages.map((message, at) =>
        at === index
          ? { ...message, text: appendMessageRefTag(message.text, sequence) }
          : message,
      ),
    };
  }
  return prepared.userPrompt.trim()
    ? { userPrompt: appendMessageRefTag(prepared.userPrompt, sequence) }
    : {};
};

export type CloudFileAttachmentMetadata = {
  kind: "file";
  name: string;
  mimeType: string;
  size?: number;
  /** Absolute path on the device that ran the turn, when there is one. */
  sourcePath?: string;
  path?: string;
  /** Owner-drive location: durable, and the only form other clients resolve. */
  drivePath?: string;
};

/**
 * The attachments a journal user row names in metadata.
 *
 * `kind: "file"` for everything listed here, because that is the shape every
 * client reads: an image that could be inlined is already carried by the
 * message as an image block and is skipped, so nothing is presented twice.
 *
 * An attachment is listed when it has a durable locator — a local absolute
 * `sourcePath`, or the drive-relative `drivePath` of a turn sent from another
 * device. A relayed attachment used to satisfy neither (the host leaves
 * `sourcePath` unset on purpose, and an image is turned into a data URL whose
 * origin was forgotten), so a message sent from the phone reached the model
 * but left the journal with no record of its files at all, and no client
 * could show them. The short-lived signed drive `url` is deliberately never
 * written here: it would be a dead link in a permanent row.
 */
const cloudFileAttachmentMetadata = (
  attachments: RuntimeAttachmentRef[] | undefined,
): CloudFileAttachmentMetadata[] =>
  (attachments ?? []).flatMap((attachment) =>
    !isInlineImageAttachment(attachment) &&
    (attachment.sourcePath || attachment.drivePath)
      ? [
          {
            kind: "file" as const,
            name: attachment.name || "attachment",
            mimeType: attachment.mimeType || "application/octet-stream",
            ...(typeof attachment.size === "number"
              ? { size: attachment.size }
              : {}),
            ...(attachment.sourcePath
              ? { sourcePath: attachment.sourcePath }
              : {}),
            ...(attachment.path ? { path: attachment.path } : {}),
            ...(attachment.drivePath
              ? { drivePath: attachment.drivePath }
              : {}),
          },
        ]
      : [],
  );

/**
 * The model-facing attachments a journaled user row can be replayed with:
 * only an absolute `sourcePath` this machine can Read. An entry that carries
 * just a `drivePath` is for clients to display; handing a drive-relative path
 * to the model as a file to open would be a broken instruction.
 */
const fileAttachmentsFromCloudUserPayload = (
  payload: unknown,
): RuntimeAttachmentRef[] => {
  const attachments = (payload as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((entry): RuntimeAttachmentRef[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (record.kind !== "file" || typeof record.sourcePath !== "string") {
      return [];
    }
    return [
      {
        url: record.sourcePath,
        sourcePath: record.sourcePath,
        kind: "file",
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.mimeType === "string"
          ? { mimeType: record.mimeType }
          : {}),
      },
    ];
  });
};

const logger = createRuntimeLogger("orchestrator-launch");

export type CloudThread = NonNullable<LocalAgentContext["threadHistory"]>;

/**
 * A row's model-visible identity. The journal stamps user rows with their
 * `message #N` tag when it reads them, so the tag is left out.
 */
const modelRowKey = (entry: CloudThread[number]): string | null => {
  const payload = (entry as { payload?: PersistedRuntimeThreadPayload })
    .payload;
  if (
    !payload ||
    (payload.role !== "user" &&
      payload.role !== "assistant" &&
      payload.role !== "toolResult")
  ) {
    return null;
  }
  const untag = (text: string) => text.replace(MESSAGE_REF_TAG_RE, "").trimEnd();
  const content =
    payload.role !== "user"
      ? payload.content
      : typeof payload.content === "string"
        ? untag(payload.content)
        : payload.content.map((block) =>
            block.type === "text" ? { ...block, text: untag(block.text) } : block,
          );
  return JSON.stringify([
    payload.role,
    content,
    payload.role === "toolResult" ? payload.toolCallId : null,
  ]);
};

/**
 * The thread this device's last cloud turn ran, when the canonical window
 * holds nothing else: the window's rows are exactly the last model-visible
 * rows of that thread. Null when another writer (a device, an agent, voice)
 * advanced the journal or the thread is unknown.
 */
export const cloudThreadExtendingCanonical = (
  remembered: CloudThread | null,
  canonical: CloudThread,
): CloudThread | null => {
  if (!remembered) return null;
  const rows = (thread: CloudThread): string[] =>
    thread
      .map((entry: CloudThread[number]) => modelRowKey(entry))
      .filter((key: string | null): key is string => key !== null);
  const keptRows = rows(remembered);
  const windowRows = rows(canonical);
  if (windowRows.length === 0 || windowRows.length > keptRows.length) {
    return null;
  }
  const offset = keptRows.length - windowRows.length;
  return windowRows.every(
    (key: string, index: number) => key === keptRows[offset + index],
  )
    ? remembered
    : null;
};

export const parseCanonicalCloudHistory = (
  serializedHistory: string[],
): NonNullable<LocalAgentContext["threadHistory"]> => {
  const messages = serializedHistory.map((serialized, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error(`Cloud transcript history row ${index} is invalid JSON.`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Cloud transcript history row ${index} is invalid.`);
    }
    const role = (parsed as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      throw new Error(
        `Cloud transcript history row ${index} has an invalid role.`,
      );
    }
    const payload = parsed as PersistedRuntimeThreadPayload;
    return payload;
  });
  const toHistoryRow = (
    payload: ReturnType<typeof createRuntimePromptAgentMessage> | PersistedRuntimeThreadPayload,
  ) => ({
    timestamp:
      typeof (payload as { timestamp?: unknown }).timestamp === "number"
        ? (payload as { timestamp: number }).timestamp
        : undefined,
    role: payload.role,
    content: buildThreadMessagePreview(payload),
    ...(payload.role === "runtimeInternal"
      ? {
          customMessage: {
            customType: payload.customType,
            content: payload.content,
            display: false,
          },
        }
      : {}),
    ...(payload.role === "toolResult"
      ? { toolCallId: payload.toolCallId }
      : {}),
    payload,
  });
  return executionContextHistoryEntries(messages).flatMap((entry) => {
    const payload =
      entry.kind === "resident"
        ? createRuntimePromptAgentMessage(entry.prompt, entry.timestamp)
        : entry.message;
    const fileAttachmentPrompt =
      payload.role === "user"
        ? createFileAttachmentPromptInput(
            fileAttachmentsFromCloudUserPayload(payload),
          )
        : null;
    if (!fileAttachmentPrompt) return [toHistoryRow(payload)];
    const timestamp =
      typeof (payload as { timestamp?: unknown }).timestamp === "number"
        ? (payload as { timestamp: number }).timestamp
        : Date.now();
    return [
      toHistoryRow(payload),
      toHistoryRow(
        createRuntimePromptAgentMessage(fileAttachmentPrompt, timestamp + 1),
      ),
    ];
  });
};

/** Longest failure reason carried into a turn notice. */
const CLOUD_FAILURE_NOTICE_REASON_CHARS = 400;

/**
 * Credential-shaped substrings that must never reach a transcript the cloud
 * stores. Upstream engine errors quote request context, and an engine CLI can
 * echo the token it was given; a notice is persisted and rendered, so redact
 * before it is written rather than trusting every upstream message.
 */
const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{8,}/g,
];

const redactSecretLike = (value: string): string =>
  SECRET_LIKE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    value,
  );

/**
 * The failure reason as a single bounded, redacted line.
 *
 * A notice is the turn's closing reply row, so a stack trace or a multi-page
 * provider payload would be the whole visible answer. Keep the first
 * meaningful line.
 */
const cloudFailureReason = (error: unknown): string | undefined => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error !== undefined && error !== null
          ? String(error)
          : "";
  const line = redactSecretLike(raw)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > CLOUD_FAILURE_NOTICE_REASON_CHARS
    ? `${line.slice(0, CLOUD_FAILURE_NOTICE_REASON_CHARS).trimEnd()}…`
    : line;
};

/**
 * Project a finished local turn onto the cloud journal's terminal phase.
 *
 * A failure notice carries WHY. The reason used to be dropped, so an expired
 * token, an out-of-credit subscription, a usage limit, a crash and a stream
 * abort all rendered as the same "The local turn did not finish." — leaving no
 * way to tell a broken credential from an exhausted one, which is the
 * difference between re-authenticating and switching accounts.
 */
const cloudFinishPhase = (
  terminal: DeferredTerminalCallback | null,
  error: unknown,
): {
  phase: "completed" | "failed" | "canceled" | "timeout";
  notice?: string;
} => {
  if (terminal?.kind === "interrupted") {
    const timedOut = /time(?:d)?\s*out|timeout/i.test(terminal.event.reason);
    return timedOut
      ? { phase: "timeout", notice: "The local turn timed out." }
      : { phase: "canceled", notice: "The local turn was canceled." };
  }
  if (terminal?.kind === "error" || error !== undefined) {
    // Prefer the run's own rejection; fall back to the terminal error event,
    // which is the only carrier when the failure arrived through callbacks.
    const reason =
      cloudFailureReason(error) ??
      (terminal?.kind === "error"
        ? cloudFailureReason(terminal.event.error)
        : undefined);
    if (reason && /(?<!engine_)sign_in_required/.test(reason)) {
      return { phase: "failed", notice: GATEWAY_SIGN_IN_REQUIRED_MESSAGE };
    }
    return {
      phase: "failed",
      notice: reason
        ? `The local turn did not finish: ${reason}`
        : "The local turn did not finish.",
    };
  }
  return { phase: "completed" };
};

const flushDeferredTerminal = (
  callbacks: RuntimeRunCallbacks,
  terminal: DeferredTerminalCallback | null,
): void => {
  if (!terminal) return;
  if (terminal.kind === "end") {
    callbacks.onEnd(terminal.event);
    return;
  }
  if (terminal.kind === "error") {
    callbacks.onError(terminal.event);
    return;
  }
  callbacks.onInterrupted?.(terminal.event);
};

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  /**
   * A person typed this prompt (here or on another device). Keeps the journal
   * user row visible for a relayed chat message without touching the run's
   * own `uiVisibility`, which also drives local run/event publication.
   */
  userAuthoredPrompt?: boolean;
  /**
   * Display-only metadata for the journal user row (pasted-text and other
   * context chips), so every client renders what the sender saw.
   */
  userMessageMetadata?: { context: Record<string, unknown> };
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolWorkspaceRoot?: string;
  agentContext: LocalAgentContext;
  resolvedLlm: ResolvedLlmRoute;
  abortController: AbortController;
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  userAuthoredPrompt?: boolean;
  userMessageMetadata?: PreparedOrchestratorRun["userMessageMetadata"];
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolWorkspaceRoot?: string;
  /** Current turn's user-message id; excludes the just-appended display
   * event from the legacy pre-transition history shim. */
  userMessageId?: string;
}): Promise<PreparedOrchestratorRun> => {
  // Run admission is owned by the Effect run coordinator: it claims the
  // lane (throwing the canonical already-running error on a double
  // admission) and is the single writer of the active-run mirror.
  const runCoordinator = ensureRunCoordinator(args.context);
  runCoordinator.beginRun({
    runId: args.runId,
    conversationId: args.conversationId,
    uiVisibility: args.uiVisibility ?? "visible",
  });

  // The controller is the cooperative seam handed to the loop/tools (they
  // take plain AbortSignals); its lifecycle belongs to the run's supervisor
  // scope. Registering the abort at admission makes the pre-launch window
  // (model-route resolution, agent-context build) cancellable through the
  // same keyed fiber structure that owns the launched run — the replacement
  // for the old `activeRunAbortControllers` map entry.
  const abortController = new AbortController();
  args.context.state.supervisor.registerRun(args.runId, (reason) =>
    abortController.abort(reason),
  );

  try {
    const resolvedAgentModel = await resolveAgentModelRoute(
      args.context,
      args.agentType,
      args.modelOverride,
    );
    const resolvedLlm = resolvedAgentModel.resolvedLlm;
    if (abortController.signal.aborted) {
      throw new Error("Run canceled.");
    }
    const agentContext = await args.buildAgentContext({
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: args.runId,
      ...(args.toolWorkspaceRoot
        ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
        : {}),
      ...(args.userMessageId
        ? { currentUserMessageId: args.userMessageId }
        : {}),
      ...resolvedAgentModel,
    });
    // The list is a snapshot from where the context starts, so only a thread
    // without its resident head yet pays for the read.
    const agentRoster =
      readsAgentRoster(args) && !hasResidentHead(agentContext)
        ? await readAgentRoster(args.context, args.conversationId).catch(
            () => undefined,
          )
        : undefined;
    if (abortController.signal.aborted) {
      throw new Error("Run canceled.");
    }
    const prepared: PreparedOrchestratorRun = {
      runId: args.runId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      ...(args.storageMode ? { storageMode: args.storageMode } : {}),
      ...(args.ownerGeneration
        ? { ownerGeneration: args.ownerGeneration }
        : {}),
      userPrompt: args.userPrompt,
      ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
      ...(args.userAuthoredPrompt ? { userAuthoredPrompt: true } : {}),
      ...(args.userMessageMetadata
        ? { userMessageMetadata: args.userMessageMetadata }
        : {}),
      promptMessages: args.promptMessages,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
      attachments: args.attachments,
      ...(args.connectorDeliveryTarget
        ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
        : {}),
      ...(args.toolWorkspaceRoot
        ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
        : {}),
      agentContext: agentRoster ? { ...agentContext, agentRoster } : agentContext,
      resolvedLlm,
      abortController,
    };
    return prepared;
  } catch (error) {
    runCoordinator.releaseRun(args.runId);
    // Admission failed before any fiber launched: drop the fiberless run
    // scope (and its registered abort) so the entry cannot leak.
    args.context.state.supervisor.discardRun(args.runId);
    throw error;
  }
};

export const launchPreparedOrchestratorRun = (args: {
  context: RunnerContext;
  prepared: PreparedOrchestratorRun;
  userMessageId: string;
  runtimeCallbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
}): void => {
  const { prepared, context } = args;
  const threadKey = resolveOrchestratorThreadKey(prepared.conversationId);

  // The turn promise still owns run cleanup exactly as before (the catch
  // below is behavior-identical), but it is no longer fire-and-forget: the
  // kernel supervisor forks a root fiber for it whose interruption aborts
  // the run's controller and joins this promise, so user-cancel and worker
  // shutdown deterministically finalize the turn and everything beneath it.
  const settled = (async () => {
    const isCloudTurn = prepared.storageMode === "cloud";
    const cloudOwnerGeneration = isCloudTurn
      ? prepared.ownerGeneration?.trim()
      : null;
    if (
      isCloudTurn &&
      (!cloudOwnerGeneration ||
        cloudOwnerGeneration.length > 512 ||
        /\s/.test(cloudOwnerGeneration))
    ) {
      throw new Error(
        "Cloud conversation owner generation is unavailable for this turn.",
      );
    }
    let leaseToken: string | null = null;
    let ephemeralCaptureStarted = false;
    let seededCloudThread: CloudThread = [];
    let deferredTerminal: DeferredTerminalCallback | null = null;
    let runError: unknown;
    const callbacks: RuntimeRunCallbacks = isCloudTurn
      ? {
          ...args.runtimeCallbacks,
          onError: (event) => {
            if (event.fatal) {
              deferredTerminal = { kind: "error", event };
              return;
            }
            args.runtimeCallbacks.onError(event);
          },
          onEnd: (event) => {
            deferredTerminal = { kind: "end", event };
          },
          onInterrupted: (event) => {
            deferredTerminal = { kind: "interrupted", event };
          },
        }
      : args.runtimeCallbacks;

    try {
      if (isCloudTurn) {
        const { message: userMessage, hidden: userMessageHidden } =
          buildCloudUserMessage(prepared);
        const beginCloudTurn = (): Promise<CloudTranscriptBeginAck> =>
          context.cloudTranscript.begin({
            conversationId: prepared.conversationId,
            ownerGeneration: cloudOwnerGeneration!,
            localTurnId: prepared.runId,
            clientMsgId: args.userMessageId,
            userMessageJson: JSON.stringify(userMessage),
            ...(userMessageHidden ? { hidden: true } : {}),
            onLeaseLost: (reason) => {
              prepared.abortController.abort(
                `Cloud conversation lease ended (${reason}).`,
              );
            },
            signal: prepared.abortController.signal,
          });
        const seedCloudHistory = (window: CloudTranscriptHistory): void => {
          const canonicalHistory = parseCanonicalCloudHistory(window.history);
          // While nothing but this device's own last turn reached the journal,
          // keep the thread that turn ran, hidden prompt rows included, so the
          // request extends the last one byte for byte and the cache holds.
          const remembered =
            context.state.cloudThreads.get(prepared.conversationId) ?? null;
          const kept = cloudThreadExtendingCanonical(
            remembered,
            canonicalHistory,
          );
          const threadHistory = kept ?? canonicalHistory;
          seededCloudThread = threadHistory;
          prepared.agentContext = {
            ...prepared.agentContext,
            threadHistory,
          };
          context.runtimeStore.beginEphemeralThreadCapture({
            threadKey,
            captureId: prepared.runId,
            seedMessages: threadHistory,
          });
          ephemeralCaptureStarted = true;
          if (!kept && remembered) {
            logger.info("cloud-thread.reseeded", {
              conversationId: prepared.conversationId,
              canonicalRows: canonicalHistory.length,
              keptRows: remembered.length,
            });
          }
          // Claude Code otherwise resumes its own locally persisted CLI
          // transcript and skips Stella's supplied history. A cloud turn must
          // instead seed a fresh CLI session from the Durable Object window.
          context.runtimeStore.setThreadExternalSessionId(threadKey, null);
          context.runtimeStore.setThreadExternalDeliveredEntryId(threadKey, null);
        };
        // A different device can advance the canonical journal while this
        // computer is idle. Acquire its lease and authoritative history before
        // provider output or tools can run; cached history is not an admission
        // fence and speculative work cannot safely be replayed after a conflict.
        if (!context.cloudTranscript.peekHistory(prepared.conversationId)) {
          void context.cloudTranscript.refreshHistory(prepared.conversationId);
        }
        const begin = await beginCloudTurn();
        leaseToken = begin.leaseToken;
        seedCloudHistory(begin);
        if (!userMessageHidden) {
          const promptSeq = await context.cloudTranscript.promptSeq(
            prepared.conversationId,
            begin,
          );
          if (promptSeq !== undefined) {
            Object.assign(prepared, withCloudPromptRefTag(prepared, promptSeq));
          }
        }
        // The journal's window starts a fresh head on a new thread and after
        // the cloud compacts it; that head carries Stella's agent list.
        if (
          prepared.agentType === AGENT_IDS.ORCHESTRATOR &&
          !hasResidentHead(prepared.agentContext)
        ) {
          const agentRoster = await readAgentRoster(
            context,
            prepared.conversationId,
          ).catch(() => undefined);
          if (agentRoster) {
            prepared.agentContext = { ...prepared.agentContext, agentRoster };
          }
        }
      }

      const runPromise = runOrchestratorTurn({
        executionHost: "device",
        runId: prepared.runId,
        conversationId: prepared.conversationId,
        storageMode: prepared.storageMode,
        ownerGeneration: cloudOwnerGeneration ?? prepared.ownerGeneration,
        userMessageId: args.userMessageId,
        agentType: prepared.agentType,
        userPrompt: prepared.userPrompt,
        ...(prepared.uiVisibility
          ? { uiVisibility: prepared.uiVisibility }
          : {}),
        ...(prepared.promptMessages?.length
          ? { promptMessages: prepared.promptMessages }
          : {}),
        ...(prepared.responseTarget
          ? { responseTarget: prepared.responseTarget }
          : {}),
        attachments: prepared.attachments,
        ...(prepared.connectorDeliveryTarget
          ? { connectorDeliveryTarget: prepared.connectorDeliveryTarget }
          : {}),
        agentContext: prepared.agentContext,
        callbacks,
        toolCatalog: context.toolHost.getToolCatalog(prepared.agentType, {
          model:
            prepared.resolvedLlm.toolPolicyModel ?? prepared.resolvedLlm.model,
          agentEngine: prepared.agentContext.agentEngine,
        }),
        toolExecutor: async (
          toolName,
          toolArgs,
          toolContext,
          signal,
          onUpdate,
        ) =>
          await context.toolHost.executeTool(
            toolName,
            toolArgs,
            toolContext,
            signal,
            onUpdate,
          ),
        buildAgentShellEnvironment: context.toolHost.buildAgentShellEnvironment,
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        ...(context.cliBridgeSocketPath
          ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
          : {}),
        resolvedLlm: prepared.resolvedLlm,
        store: context.runtimeStore,
        abortSignal: prepared.abortController.signal,
        stellaAppDir: context.stellaAppDir,
        ...(prepared.toolWorkspaceRoot
          ? { toolWorkspaceRoot: prepared.toolWorkspaceRoot }
          : {}),
        hookEmitter: context.hookEmitter,
        onExecutionSessionCreated: args.onExecutionSessionCreated,
        // Provider streams and tool calls opened by this turn supervise as
        // child fibers of the run's scope, so cancelRun/shutdown interrupts
        // them and joins their teardown.
        superviseRunResource: (resource) =>
          context.state.supervisor.adoptResource(
            prepared.runId,
            resource.label,
            {
              abort: resource.abort,
              settled: resource.settled,
            },
          ),
        compactionScheduler: context.state.compactionScheduler,
        ...(readsAgentRoster(prepared)
          ? {
              readAgentRoster: () =>
                readAgentRoster(context, prepared.conversationId),
            }
          : {}),
      });
      await runPromise;
    } catch (error) {
      runError = error;
    } finally {
      try {
        // Cloud terminal callbacks are deferred below, so profile durability
        // joins before transcript completion and the terminal event publish.
        await context.toolHost.endBrowserTurn(prepared.runId, "retain-tabs");
      } catch (browserFinalizationError) {
        // Preserve the original run failure when both paths fail; otherwise a
        // lost browser checkpoint makes this run fail deterministically.
        if (runError === undefined) {
          runError = browserFinalizationError;
        } else {
          console.error(
            "Browser turn finalization also failed after the run error:",
            browserFinalizationError,
          );
        }
      }
    }

    if (isCloudTurn && leaseToken) {
      try {
        const captured = !ephemeralCaptureStarted
          ? []
          : context.runtimeStore.readEphemeralThreadCapture({
              threadKey,
              captureId: prepared.runId,
            });
        const records = captured
          .filter(
            (message) =>
              message.payload !== undefined &&
              (message.payload.role === "assistant" ||
                message.payload.role === "toolResult"),
          )
          .map((message, ordinal) => ({
            ordinal,
            role: message.payload!.role as "assistant" | "toolResult",
            payloadJson: JSON.stringify(message.payload),
          }));
        const reportCloudSyncFailure = (message: string): void => {
          args.runtimeCallbacks.onError({
            runId: prepared.runId,
            agentType: prepared.agentType,
            seq: Date.now(),
            error: message,
            fatal: false,
            ...(prepared.uiVisibility
              ? { uiVisibility: prepared.uiVisibility }
              : {}),
          });
        };
        const finishStatus = await context.cloudTranscript.finish({
          conversationId: prepared.conversationId,
          ownerGeneration: cloudOwnerGeneration!,
          localTurnId: prepared.runId,
          leaseToken,
          records,
          ...cloudFinishPhase(deferredTerminal, runError),
          failureNotificationUserMessageId: args.userMessageId,
          onDeliveryFailure: reportCloudSyncFailure,
        });
        if (!finishStatus.queued) {
          reportCloudSyncFailure(
            "This response finished on this device but was too large to sync to your cloud conversation.",
          );
        }
        // Only a completed turn the journal accepted is a thread the next
        // turn can extend; anything else reseeds from canonical history.
        // `deferredTerminal` is assigned from the run's callbacks.
        const terminal = deferredTerminal as DeferredTerminalCallback | null;
        if (
          finishStatus.queued &&
          runError === undefined &&
          (terminal === null || terminal.kind === "end")
        ) {
          context.state.cloudThreads.set(prepared.conversationId, [
            ...seededCloudThread,
            ...captured,
          ]);
        } else {
          context.state.cloudThreads.delete(prepared.conversationId);
        }
        flushDeferredTerminal(args.runtimeCallbacks, deferredTerminal);
      } finally {
        if (ephemeralCaptureStarted) {
          context.runtimeStore.endEphemeralThreadCapture({
            threadKey,
            captureId: prepared.runId,
          });
        }
      }
    } else if (isCloudTurn && ephemeralCaptureStarted) {
      context.runtimeStore.endEphemeralThreadCapture({
        threadKey,
        captureId: prepared.runId,
      });
    }
    if (runError !== undefined) throw runError;
  })().catch((error) => {
    if (error instanceof CloudTranscriptAlreadyAdmittedError) {
      // The cloud journal has already accepted this stable client message,
      // usually after an IPC response was lost across a desktop restart. The
      // canonical cloud feed owns reconciliation; emitting a fatal local error
      // here would turn successful deduplication into a false failure card.
      args.cleanupRun(prepared.runId);
      return;
    }
    if (isReportedOrchestratorError(error)) {
      return;
    }
    args.cleanupRun(prepared.runId);
    args.onFatalError(error);
  });

  context.state.supervisor.startRun(prepared.runId, {
    abort: (reason) => prepared.abortController.abort(reason),
    settled,
  });
};

export const startPreparedOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  createRuntimeCallbacks: (args: {
    runId: string;
    prepared: PreparedOrchestratorRun;
  }) => RuntimeRunCallbacks;
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  userAuthoredPrompt?: boolean;
  userMessageMetadata?: PreparedOrchestratorRun["userMessageMetadata"];
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  userMessageId: string;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void | Promise<void>;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
}): Promise<{ runId: string; prepared: PreparedOrchestratorRun }> => {
  const prepared = await prepareOrchestratorRun({
    context: args.context,
    buildAgentContext: args.buildAgentContext,
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    ...(args.storageMode ? { storageMode: args.storageMode } : {}),
    ...(args.ownerGeneration ? { ownerGeneration: args.ownerGeneration } : {}),
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    ...(args.userAuthoredPrompt ? { userAuthoredPrompt: true } : {}),
    ...(args.userMessageMetadata
      ? { userMessageMetadata: args.userMessageMetadata }
      : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(args.connectorDeliveryTarget
      ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
      : {}),
    userMessageId: args.userMessageId,
  });

  try {
    await args.onPrepared?.(prepared);
    if (prepared.abortController.signal.aborted) {
      throw new Error("Run canceled before execution.");
    }
  } catch (error) {
    ensureRunCoordinator(args.context).releaseRun(args.runId);
    args.context.state.supervisor.discardRun(args.runId);
    throw error;
  }

  launchPreparedOrchestratorRun({
    context: args.context,
    prepared,
    userMessageId: args.userMessageId,
    runtimeCallbacks: args.createRuntimeCallbacks({
      runId: args.runId,
      prepared,
    }),
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
