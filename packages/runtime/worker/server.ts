import crypto from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
// Photon itself is lazy-loaded inside resizeImage, so this import adds no
// WASM parse cost to the worker-ready path.
import { resizeImage } from "../kernel/shared/image-resize.js";
import {
  resolveImageCaps,
  type ImageCapTarget,
  type ImageCaps,
} from "../ai/utils/image-caps.js";
import {
  detectImageMimeTypeFromBytes,
  imageMimeTypeFromPath,
} from "../kernel/shared/image-mime.js";
import type { WorkerPeerLike } from "./peer-broker.js";

type ConnectCardOutcome =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

/**
 * Host hop for the inline connect cards (connector + browser extension).
 * Attaches a worker-generated `offerId` so a turn abort can cancel the
 * pending desktop card via `host.connectorConnect.cancel` instead of
 * leaving it up until the desktop's own timeout.
 */
const requestConnectCardFromHost = async (
  peer: WorkerPeerLike,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ConnectCardOutcome> => {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  const offerId = crypto.randomUUID();
  const request: Promise<ConnectCardOutcome> = peer
    .request<ConnectCardOutcome>(
      method,
      { ...payload, offerId },
      { retryOnDisconnect: true },
    )
    .catch((error: unknown) => ({
      ok: false as const,
      reason: (error as Error).message || "host_unreachable",
    }));
  if (!signal) return await request;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const winner = await Promise.race([request, aborted]);
    if (winner !== "aborted") return winner;
    // Best-effort: settle the desktop card as cancelled right away.
    void peer
      .request(METHOD_NAMES.HOST_CONNECTOR_CONNECT_CANCEL, { offerId })
      .catch(() => undefined);
    // Swallow the eventual host response — the turn is gone.
    void request.catch(() => undefined);
    return { ok: false, reason: "cancelled" };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};
import { getFileLogger } from "../observability/file-logger.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type AgentHealth,
  type HostDeviceIdentity,
  type HostAppBrowserContextSnapshot,
  type HostLlmCredentialsRequest,
  type HostLlmCredentialsResult,
  type RuntimeAttachmentRef,
  type RuntimeAgentEventPayload,
  type RuntimeChatPayload,
  type RuntimePromptMessage,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
  type RuntimeVoiceToolCallPayload,
  type RuntimeLocalAgentRequest,
} from "@stella/contracts/protocol";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentRunFinishOutcome,
  type AgentStreamEventType,
} from "@stella/contracts/agent-runtime";
import type { AssistantWorkingMode } from "@stella/contracts/local-preferences";
import { fileChange } from "@stella/contracts/file-changes";
import { prepareStoredLocalChatPayload } from "../kernel/storage/local-chat-payload.js";
import { getAssistantWorkingMode } from "../kernel/preferences/local-preferences.js";
import { collectAllSignals } from "../discovery/collect-all.js";
import { sweepStaleConnectorBridgeProcesses } from "../kernel/connectors/process-registry.js";
import {
  setConnectorTokenStoreBroker,
  type ConnectorTokenPayload,
} from "../kernel/connectors/oauth.js";
import type { ConnectorTokenStoreRequest } from "../kernel/connectors/cli-broker-client.js";
import { setLocalLlmCredentialAccessBroker } from "../kernel/storage/local-llm-credential-access.js";
import {
  collectBrowserData,
  formatBrowserDataForSynthesis,
} from "../discovery/browser-data.js";
// Runner subgraph imported as types only — the values are loaded lazily (see
// loadOneShotCompletion / loadChatPromptContext and the dynamic import in
// buildRunner) so this ~68%-of-bundle subgraph isn't parsed on the worker-ready
// path.
import type {
  createStellaHostRunner,
  StellaHostRunnerOptions,
} from "../kernel/runner.js";
import {
  startCliBridgeServer,
  type CliBridgeServer,
} from "./cli-bridge-server.js";
import {
  createSecureCliBridgeEndpoint,
  resolveRuntimePaths,
} from "./runtime-paths.js";
import { createBackendConnectorActionBroker } from "./backend-connector-action-broker.js";
import {
  afterRequiredCliBridgeReady,
  connectorActionBrokerAvailability,
} from "./required-cli-bridge.js";
import { createDesktopDatabase } from "../kernel/storage/database.js";
import { ChatStore } from "../kernel/storage/chat-store.js";
import { RuntimeStore } from "../kernel/storage/runtime-store.js";
import { RunEventLog } from "../kernel/storage/run-event-log.js";
import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "../kernel/storage/recall-read-queries.js";
import type {
  LocalChatEventRecord,
  SqliteDatabase,
} from "../kernel/storage/shared.js";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import { SocialSessionService } from "./social-sessions/service.js";
import { SocialSessionStore } from "./social-sessions/store.js";
import { UserAppProjectService } from "./user-apps/project-service.js";
import { VoiceRuntimeService } from "./voice/service.js";
import { createRuntimeLogger } from "../kernel/debug.js";

type WorkerInitializationState = {
  protocolVersion?: string;
  stellaAppDir: string;
  stellaDataDirPath: string;
  stellaWorkspacePath: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
  modelCatalogUpdatedAt: number | null;
  localLlmCredentialsUpdatedAt: number | null;
};

const notifyLocalChatUpdated = (
  peer: WorkerPeerLike,
  conversationId?: string,
  event?: LocalChatEventRecord,
) => {
  peer.notify(
    NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
    event || conversationId
      ? {
          ...(conversationId ? { conversationId } : {}),
          ...(event ? { event } : {}),
        }
      : null,
  );
};

const logger = createRuntimeLogger("worker.server");

type RuntimeRunner = ReturnType<typeof createStellaHostRunner>;

const resolveDesktopCliEntrypoint = (
  stellaAppDir: string,
  packageName: string,
  entrypoint: string,
): string => {
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, packageName, "bin", entrypoint);
    if (existsSync(packaged)) {
      return packaged;
    }
  }
  const desktopLocal = path.join(
    stellaAppDir,
    "desktop",
    packageName,
    "bin",
    entrypoint,
  );
  if (existsSync(desktopLocal)) {
    return desktopLocal;
  }

  return path.join(stellaAppDir, packageName, "bin", entrypoint);
};

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry" | "model-fallback";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  details?: unknown;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  agentId?: string;
  agentType?: AgentIdLike;
  rootRunId?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  assistantMessageEventId?: string;
  assistantMessageText?: string;
};

type WorkerState = {
  init: WorkerInitializationState | null;
  db: SqliteDatabase | null;
  chatStore: ChatStore | null;
  runtimeStore: RuntimeStore | null;
  socialSessionStore: SocialSessionStore | null;
  socialSessionService: SocialSessionService | null;
  userAppProjectService: UserAppProjectService | null;
  voiceService: VoiceRuntimeService | null;
  runner: RuntimeRunner | null;
  // Shared promise for the background runner build (lazy chunk import). Null
  // when no build is in flight; resolves to the runner once constructed.
  runnerReadyPromise: Promise<RuntimeRunner> | null;
  runnerReadyError: string | null;
  deviceId: string | null;
  /**
   * Persistent ring buffer for streaming run events. Every event we emit
   * via NOTIFICATION_NAMES.RUN_EVENT also gets persisted here so that a
   * reconnecting host (for example, after an Electron restart)
   * can replay anything past its `lastSeq` without losing in-flight work.
   * See runtime/kernel/storage/run-event-log.ts.
   */
  runEventLog: RunEventLog | null;
  /**
   * UDS bridge the worker exposes for sidecar processes (the
   * `stella-computer` daemon spawn path) and the in-process node_repl
   * `connect` client that need to call back into the host without the full
   * runtime JSON-RPC protocol. Started on first init, restarted if
   * the worker re-inits with a new stellaAppDir, stopped on shutdown.
   * See `cli-bridge-server.ts`.
   */
  cliBridgeServer: CliBridgeServer | null;
};

// Resolve a runtime CLI bundled into desktop/dist-electron/runtime/kernel/cli/.
const resolveRuntimeCliPath = (fileName: string) =>
  resolveBundledRuntimeFile(`kernel/cli/${fileName}`);

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

import {
  approximateDataUrlBytes,
  attachPersistedImagePaths,
  buildSpilledAttachmentNotice,
  dataUrlBase64Length,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  MAX_INLINE_IMAGE_BASE64_BYTES,
  spillImageAttachmentsToDisk,
  type SpilledImageAttachment,
} from "./chat-attachment-spill.js";

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;
const HTTP_URL_RE = /^https?:\/\//i;

type MaterializedImageAttachment = {
  index: number;
  attachment: RuntimeAttachmentRef;
};

const normalizeAttachmentMimeType = (
  value: string | null | undefined,
): string => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const isImageMimeType = (mimeType: string): boolean =>
  mimeType.startsWith("image/");

const encodeImageDataUrl = (mimeType: string, data: ArrayBuffer): string =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

/**
 * Pi-style attachment sizing: resize each composer image to fit the
 * per-image vision budget before it ever reaches the prompt. With every
 * image ≤4.5MB base64 (typically a few hundred KB), whole batches inline
 * directly and the spill-to-disk + Read fallback only triggers for
 * genuinely huge sets. Falls back to the original bytes when Photon
 * can't decode the format.
 */
const resizeImageDataUrl = async (
  dataUrl: string,
  mimeType: string,
  caps?: ImageCaps,
): Promise<string> => {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return dataUrl;
  try {
    const resized = await resizeImage(
      Buffer.from(match[2] ?? "", "base64"),
      mimeType,
      caps,
    );
    if (!resized?.wasResized) return dataUrl;
    return `data:${resized.mimeType};base64,${resized.data}`;
  } catch {
    return dataUrl;
  }
};

const FILE_URL_RE = /^file:\/\//i;

const isLocalFileAttachmentUrl = (url: string): boolean =>
  FILE_URL_RE.test(url) || path.isAbsolute(url);

const materializeLocalFileImage = async (
  url: string,
  caps?: ImageCaps,
): Promise<RuntimeAttachmentRef | null> => {
  const filePath = FILE_URL_RE.test(url) ? fileURLToPath(url) : url;
  const data = await fsPromises.readFile(filePath);
  const mimeType =
    detectImageMimeTypeFromBytes(data) ?? imageMimeTypeFromPath(filePath);
  if (!mimeType) {
    return null;
  }
  const resized = await resizeImage(data, mimeType, caps);
  if (resized) {
    return {
      url: `data:${resized.mimeType};base64,${resized.data}`,
      mimeType: resized.mimeType,
    };
  }
  return {
    url: `data:${mimeType};base64,${data.toString("base64")}`,
    mimeType,
  };
};

const materializeImageAttachments = async (
  attachments: RuntimeAttachmentRef[] | undefined,
  target?: ImageCapTarget,
): Promise<MaterializedImageAttachment[]> => {
  const materialized: MaterializedImageAttachment[] = [];
  // Resize composer attachments to the resolved target provider's limits
  // (e.g. Anthropic's 2576px high-res tier) rather than a blunt global cap.
  // Falls back to the safe conservative profile when the target is unknown.
  const caps = resolveImageCaps({
    ...(target ?? {}),
    imageCount: (attachments ?? []).length,
  });

  for (const [index, attachment] of (attachments ?? []).entries()) {
    const url = asTrimmedString(attachment.url);
    if (!url) {
      continue;
    }

    // Path-backed composer attachments: the renderer keeps only the
    // path + preview; the original bytes are read and resized here.
    if (isLocalFileAttachmentUrl(url)) {
      try {
        const localImage = await materializeLocalFileImage(url, caps);
        if (localImage) {
          materialized.push({ index, attachment: localImage });
        }
      } catch (error) {
        logger.warn("startChat.attachment-materialize-failed", {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const hintedMimeType = normalizeAttachmentMimeType(attachment.mimeType);
    const dataUrlMatch = DATA_URL_RE.exec(url);
    if (dataUrlMatch) {
      const mimeType =
        hintedMimeType || normalizeAttachmentMimeType(dataUrlMatch[1]);
      if (!isImageMimeType(mimeType)) {
        continue;
      }
      const resizedUrl = await resizeImageDataUrl(url, mimeType, caps);
      materialized.push({
        index,
        attachment: {
          url: resizedUrl,
          mimeType:
            DATA_URL_RE.exec(resizedUrl)?.[1]?.toLowerCase() ?? mimeType,
        },
      });
      continue;
    }

    if (!HTTP_URL_RE.test(url)) {
      continue;
    }
    if (hintedMimeType && !isImageMimeType(hintedMimeType)) {
      continue;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn("startChat.attachment-materialize-failed", {
          url,
          status: response.status,
          statusText: response.statusText,
        });
        continue;
      }

      const responseMimeType = normalizeAttachmentMimeType(
        response.headers.get("content-type"),
      );
      const mimeType = responseMimeType || hintedMimeType;
      if (!isImageMimeType(mimeType)) {
        continue;
      }

      const fetchedUrl = encodeImageDataUrl(
        mimeType,
        await response.arrayBuffer(),
      );
      const resizedUrl = await resizeImageDataUrl(fetchedUrl, mimeType, caps);
      materialized.push({
        index,
        attachment: {
          url: resizedUrl,
          mimeType:
            DATA_URL_RE.exec(resizedUrl)?.[1]?.toLowerCase() ?? mimeType,
        },
      });
    } catch (error) {
      logger.warn("startChat.attachment-materialize-failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return materialized;
};

const stopWorkerServices = async (state: WorkerState) => {
  await state.userAppProjectService?.shutdown().catch(() => undefined);
  state.userAppProjectService = null;
  state.socialSessionService?.stop();
  state.socialSessionService = null;
  state.voiceService = null;
  // `runner.stop()` now awaits a bounded drain of the background
  // compaction scheduler so SQLite writes complete before we close
  // `state.db`. Without this await, an in-flight `compactThread` could
  // race the `db.close()` below.
  // If the runner is still building in the background (lazy chunk import), wait
  // for it to finish so we don't strand a started-but-unreferenced runner after
  // nulling state.runner. The build's own supersede guard (state.db !== db) may
  // already have stopped it; awaiting here is still safe (stop is idempotent).
  const pendingRunnerReady = state.runnerReadyPromise;
  state.runnerReadyPromise = null;
  state.runnerReadyError = null;
  if (pendingRunnerReady) {
    await pendingRunnerReady.catch(() => undefined);
  }
  await state.runner?.stop();
  state.runner = null;
  state.chatStore = null;
  state.runtimeStore = null;
  state.socialSessionStore = null;
  state.runEventLog?.stop();
  state.runEventLog = null;
  await state.cliBridgeServer?.stop().catch(() => undefined);
  state.cliBridgeServer = null;
  setConnectorTokenStoreBroker(null);
  setLocalLlmCredentialAccessBroker(null);
  state.db?.close();
  state.db = null;
};

export const createRuntimeWorkerServer = (peer: WorkerPeerLike) => {
  let shuttingDown = false;
  let unsubscribeFromModelCatalog: (() => void) | undefined;
  let modelRuntimeModule:
    | Promise<typeof import("../ai/model-runtime.js")>
    | undefined;
  const ensureModelRuntimeSubscription = async () => {
    const loaded = await (modelRuntimeModule ??= import(
      "../ai/model-runtime.js"
    ));
    if (!shuttingDown) {
      unsubscribeFromModelCatalog ??= loaded.modelRuntime.onCatalogChanged(
        (snapshot) => {
          peer.notify(NOTIFICATION_NAMES.MODEL_CATALOG_UPDATED, snapshot);
        },
      );
    }
    return loaded.modelRuntime;
  };
  const state: WorkerState = {
    init: null,
    db: null,
    chatStore: null,
    runtimeStore: null,
    socialSessionStore: null,
    socialSessionService: null,
    userAppProjectService: null,
    voiceService: null,
    runner: null,
    runnerReadyPromise: null,
    runnerReadyError: null,
    deviceId: null,
    runEventLog: null,
    cliBridgeServer: null,
  };

  // Lazy loaders for the runner subgraph. runner.ts, one-shot-completion.ts and
  // chat-prompt-context.ts share ~80 files and together are ~68% of the worker
  // bundle's eager parse, yet are only needed once a turn/review actually runs.
  // Importing them on first use (and building the runner in the post-ready
  // background slot) keeps that parse off the worker-ready path. The dynamic
  // import()s are also what let esbuild split them into their own chunk.
  let oneShotCompletionModule: Promise<
    typeof import("../kernel/agent-runtime/one-shot-completion.js")
  > | null = null;
  const loadOneShotCompletion = () =>
    (oneShotCompletionModule ??= import(
      "../kernel/agent-runtime/one-shot-completion.js"
    ));
  let chatPromptContextModule: Promise<
    typeof import("../kernel/chat-prompt-context.js")
  > | null = null;
  const loadChatPromptContext = () =>
    (chatPromptContextModule ??= import("../kernel/chat-prompt-context.js"));

  const emitRunEvent = (event: AgentEventPayload) => {
    // Persist to the run event log BEFORE emitting on the wire so a host
    // that disconnects mid-notify still sees the event on reconnect.
    // INSERT OR IGNORE collapses (runId, seq) collisions for the rare
    // synthetic terminal markers (e.g. seq=MAX_SAFE_INTEGER) — both copies
    // describe the same terminal state, so retaining the first is fine.
    state.runEventLog?.append({
      runId: event.runId,
      seq: event.seq,
      payload: event as unknown as Record<string, unknown>,
    });
    peer.notify(NOTIFICATION_NAMES.RUN_EVENT, event);
  };

  const emitVoiceAgentEvent = (payload: {
    requestId: string;
    event: RuntimeAgentEventPayload;
  }) => {
    peer.notify(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, payload);
  };

  const hasActiveWork = (): boolean => {
    // Keep this in sync with host-side shouldKeepWorkerAlive plus
    // worker-only work that the host cannot observe after disconnect.
    const socialSessions =
      state.socialSessionService?.getSnapshot() ??
      createEmptySocialSessionServiceSnapshot();
    const socialPinned =
      socialSessions.sessionCount > 0 ||
      Boolean(socialSessions.processingTurnId);
    const voicePinned =
      (state.voiceService?.isBusy() ?? false) ||
      (state.voiceService?.getPendingRequestCount() ?? 0) > 0;
    const userAppPinned = state.userAppProjectService?.hasActiveWork() ?? false;
    const requestPinned = (peer.activeRequestHandlerCount?.() ?? 0) > 0;
    return Boolean(
      state.runner?.getActiveOrchestratorRun() ||
        (state.runner?.getActiveAgentCount() ?? 0) > 0 ||
        requestPinned ||
        socialPinned ||
        voicePinned ||
        userAppPinned,
    );
  };

  /**
   * Append a fresh persisted assistant row for one completed assistant
   * message within a run. A Pi orchestrator run may emit several
   * assistant messages (preamble, post-tool answer, …); each gets its
   * own row keyed by `(runId, seq)` so they render linearly in
   * chronological order rather than collapsing into a single
   * `assistant-for-<userMessageId>` row that overwrites itself.
   *
   * Returns the persisted eventId so callers can track the latest row.
   */
  const appendAssistantMessageForTurn = (args: {
    conversationId: string;
    text: string;
    userMessageId: string;
    runId: string;
    seq: number;
    timezone?: string;
    responseTarget?: RuntimeAgentEventPayload["responseTarget"];
    streamStartedAtMs?: number;
    workingMode: AssistantWorkingMode;
    followedByToolCall?: boolean;
  }): LocalChatEventRecord | null => {
    const trimmedText = args.text.trim();
    if (!trimmedText) {
      return null;
    }

    const runtimeMetadata = {
      runtime: {
        workingMode: args.workingMode,
        ...(args.followedByToolCall ? { followedByToolCall: true } : {}),
        ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
        ...(Number.isFinite(args.streamStartedAtMs)
          ? { streamStartedAtMs: args.streamStartedAtMs }
          : {}),
      },
    };

    const eventId = `assistant-msg-${args.runId}-${args.seq}`;
    const event = ensureChatStore().appendEvent({
      conversationId: args.conversationId,
      eventId,
      type: "assistant_message",
      requestId: args.userMessageId,
      payload: prepareStoredLocalChatPayload({
        type: "assistant_message",
        payload: {
          text: trimmedText,
          userMessageId: args.userMessageId,
          ...(runtimeMetadata ? { metadata: runtimeMetadata } : {}),
        },
        timestamp: Date.now(),
        timezone: args.timezone,
      }),
    });
    notifyLocalChatUpdated(peer, args.conversationId, event);
    return event;
  };

  const markAssistantTurnComplete = (args: {
    conversationId: string;
    event: LocalChatEventRecord | null;
  }): LocalChatEventRecord | null => {
    if (!args.event?.payload) return args.event;
    const currentMetadata =
      args.event.payload.metadata &&
      typeof args.event.payload.metadata === "object"
        ? (args.event.payload.metadata as Record<string, unknown>)
        : {};
    const currentRuntime =
      currentMetadata.runtime && typeof currentMetadata.runtime === "object"
        ? (currentMetadata.runtime as Record<string, unknown>)
        : {};
    const event = ensureChatStore().appendEvent({
      conversationId: args.conversationId,
      eventId: args.event._id,
      type: args.event.type,
      ...(args.event.requestId ? { requestId: args.event.requestId } : {}),
      timestamp: args.event.timestamp,
      payload: {
        ...args.event.payload,
        metadata: {
          ...currentMetadata,
          runtime: {
            ...currentRuntime,
            turnComplete: true,
          },
        },
      },
    });
    notifyLocalChatUpdated(peer, args.conversationId, event);
    return event;
  };

  const ensureRunner = () => {
    if (!state.runner) {
      throw new Error(state.runnerReadyError ?? "Runtime worker is not ready.");
    }
    return state.runner;
  };

  const joinRunnerBuild = async () => {
    // The runner is built in the background after the worker reports ready, so
    // the first request can arrive before state.runner exists. Join the shared
    // build promise (swallow its error; ensureRunner() then surfaces the real
    // failure or returns the built runner).
    if (!state.runner && state.runnerReadyPromise) {
      await state.runnerReadyPromise.catch(() => undefined);
    }
  };

  const ensureRunnerInitialized = async () => {
    // Join the background build (see joinRunnerBuild), then ensureRunner()
    // returns the runner or throws if it failed or was superseded.
    await joinRunnerBuild();
    const runner = ensureRunner();
    await runner.waitUntilInitialized();
    return runner;
  };

  const ensureChatStore = () => {
    if (!state.chatStore) {
      throw new Error("Chat store is not available.");
    }
    return state.chatStore;
  };

  const ensureVoiceService = () => {
    if (!state.voiceService) {
      throw new Error("Voice runtime service is not available.");
    }
    return state.voiceService;
  };

  const requestHostLlmCredentials = async (
    request: HostLlmCredentialsRequest,
  ): Promise<HostLlmCredentialsResult> =>
    await peer.request(METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST, request, {
      retryOnDisconnect: true,
    });

  const refreshLocalLlmCredentialAccess = async (): Promise<void> => {
    const result = await requestHostLlmCredentials({ operation: "list" });
    if (
      !result.ok ||
      !("apiKeyProviders" in result) ||
      !("oauthProviders" in result)
    ) {
      throw new Error(
        `Desktop credential storage is unavailable: ${result.ok ? "invalid_response" : result.reason}`,
      );
    }
    const apiKeyProviders = new Set(
      result.apiKeyProviders.map((provider) => provider.trim().toLowerCase()),
    );
    const oauthProviders = new Set(
      result.oauthProviders.map((provider) => provider.trim().toLowerCase()),
    );
    setLocalLlmCredentialAccessBroker({
      hasApiKey: (provider) => apiKeyProviders.has(provider),
      hasOAuth: (provider) => oauthProviders.has(provider),
      getApiKey: async (provider) => {
        const value = await requestHostLlmCredentials({
          operation: "get",
          kind: "api-key",
          provider,
        });
        return value.ok && "value" in value ? value.value : null;
      },
      getOAuthApiKey: async (provider) => {
        const value = await requestHostLlmCredentials({
          operation: "get",
          kind: "oauth-api-key",
          provider,
        });
        return value.ok && "value" in value ? value.value : null;
      },
    });
  };

  const initializeWorker = async (init: WorkerInitializationState) => {
    if (
      init.protocolVersion &&
      init.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION
    ) {
      throw new Error(
        `Runtime protocol mismatch: host=${init.protocolVersion} worker=${STELLA_RUNTIME_PROTOCOL_VERSION}.`,
      );
    }
    const sameRuntimeRoot =
      state.init?.stellaAppDir === init.stellaAppDir &&
      state.init?.stellaDataDirPath === init.stellaDataDirPath &&
      state.init?.stellaWorkspacePath === init.stellaWorkspacePath;
    if (sameRuntimeRoot && state.runner) {
      applyConfigPatch(init);
      return {
        protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
        pid: process.pid,
        deviceId: state.deviceId,
      };
    }
    await stopWorkerServices(state);
    state.init = init;

    const db = createDesktopDatabase(init.stellaDataDirPath);
    const chatStore = new ChatStore(db, {
      onThreadActivityUpdate: (payload: unknown) => {
        peer.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
      onThreadAssistantUpdate: (payload: unknown) => {
        peer.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
      onThreadTranscriptUpdate: (payload: unknown) => {
        peer.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, payload);
      },
    });
    const runtimeStore = chatStore as RuntimeStore;
    const socialSessionStore = new SocialSessionStore(db);
    const runEventLog = new RunEventLog(db);
    const deviceIdentity = await peer.request<HostDeviceIdentity>(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    state.deviceId = deviceIdentity.deviceId;
    state.db = db;
    state.chatStore = chatStore;
    state.runtimeStore = runtimeStore;
    state.socialSessionStore = socialSessionStore;
    state.runEventLog = runEventLog;
    await refreshLocalLlmCredentialAccess();
    const bridgePaths = resolveRuntimePaths(init.stellaAppDir);
    const brokerAvailability = connectorActionBrokerAvailability(
      process.platform,
    );
    const cliBridgeSocketPath = brokerAvailability.supported
      ? createSecureCliBridgeEndpoint(bridgePaths)
      : undefined;

    const runEventLogStartupBackfill = () => {
      if (state.runEventLog !== runEventLog) return;
      for (const buffered of runEventLog.listBufferedRuns()) {
        if (buffered.hasTerminalEvent) continue;
        runEventLog.append({
          runId: buffered.runId,
          seq: Number.MAX_SAFE_INTEGER,
          payload: {
            type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
            runId: buffered.runId,
            seq: Number.MAX_SAFE_INTEGER,
            conversationId: buffered.conversationId,
            outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: "worker_restart",
            error: "Stella restarted before this run could finish.",
            rootRunId: buffered.runId,
          },
        });
      }
      runEventLog.startBackgroundSweep();
    };

    const startCliBridge = async () => {
      if (state.db !== db) return;
      if (!brokerAvailability.supported || !cliBridgeSocketPath) {
        console.warn(
          `[cli-bridge] ${"reason" in brokerAvailability ? brokerAvailability.reason : "Connector action broker is unavailable."}`,
        );
        return;
      }
      const refreshSiteAuth = async () => {
        const result = (await peer.request(
          METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
          { source: "connector" },
          { retryOnDisconnect: true },
        )) as {
          authenticated: boolean;
          token: string | null;
          hasConnectedAccount: boolean;
        };
        if (state.init) {
          state.init = {
            ...state.init,
            authToken: result.authenticated ? result.token : null,
            hasConnectedAccount: result.hasConnectedAccount,
          };
          state.runner?.setAuthToken(state.init.authToken);
          state.runner?.setHasConnectedAccount(state.init.hasConnectedAccount);
        }
        const baseUrl = state.init?.convexSiteUrl?.trim();
        const authToken = result.authenticated ? result.token?.trim() : null;
        return baseUrl && authToken ? { baseUrl, authToken } : null;
      };
      const runBackendConnectorAction = createBackendConnectorActionBroker({
        stellaDataDir: init.stellaDataDirPath,
        getSiteAuth: () => {
          const baseUrl = state.init?.convexSiteUrl?.trim();
          const authToken = state.init?.authToken?.trim();
          return baseUrl && authToken ? { baseUrl, authToken } : null;
        },
        refreshSiteAuth: async () => {
          try {
            return await refreshSiteAuth();
          } catch {
            return null;
          }
        },
      });
      const requestHostConnectorTokenStore = async (
        request: ConnectorTokenStoreRequest,
      ) =>
        await peer.request<{
          ok: boolean;
          payload?: ConnectorTokenPayload | null;
          reason?: string;
        }>(METHOD_NAMES.HOST_CONNECTOR_TOKEN_STORE_REQUEST, request);

      // Protected connector credentials stay on owner-only local IPC. The
      // worker and shipped CLI receive plaintext only in memory for a request.
      setConnectorTokenStoreBroker({
        load: async (tokenKey) => {
          const result = await requestHostConnectorTokenStore({
            operation: "load",
            tokenKey,
          });
          if (!result.ok) throw new Error(result.reason ?? "token_load_failed");
          return result.payload ?? null;
        },
        save: async (tokenKey, payload) => {
          const result = await requestHostConnectorTokenStore({
            operation: "save",
            tokenKey,
            payload,
          });
          if (!result.ok) throw new Error(result.reason ?? "token_save_failed");
        },
        delete: async (tokenKeys) => {
          const result = await requestHostConnectorTokenStore({
            operation: "delete",
            tokenKeys,
          });
          if (!result.ok)
            throw new Error(result.reason ?? "token_delete_failed");
        },
      });
      const cliBridgeServer = await startCliBridgeServer({
        socketPath: cliBridgeSocketPath,
        log: (message, error) => {
          if (error) {
            console.warn(`[cli-bridge] ${message}:`, error);
          } else {
            console.warn(`[cli-bridge] ${message}`);
          }
        },
        handlers: {
          runBackendConnectorAction,
          requestConnectorCredential: async (params) => {
            try {
              return await peer.request<
                | { ok: true }
                | {
                    ok: false;
                    reason: "cancelled" | "timeout" | "unsupported" | string;
                  }
              >(METHOD_NAMES.HOST_CONNECTOR_CREDENTIAL_REQUEST, params, {
                retryOnDisconnect: true,
              });
            } catch (error) {
              return {
                ok: false,
                reason: (error as Error).message || "host_unreachable",
              };
            }
          },
          requestDesktopPermission: async ({ kind }) => {
            try {
              const result = await peer.request<{
                granted: boolean;
                alreadyGranted: boolean;
              }>(METHOD_NAMES.HOST_SYSTEM_REQUEST_PERMISSION, kind, {
                retryOnDisconnect: true,
              });
              return { ok: true, ...result };
            } catch (error) {
              return {
                ok: false,
                reason: (error as Error).message || "host_unreachable",
              };
            }
          },
          spawnAutomationDaemon: async (params) => {
            try {
              return await peer.request<
                | { ok: true; pid: number; hostPid: number }
                | { ok: false; reason: string }
              >(
                METHOD_NAMES.HOST_COMPUTER_USE_SPAWN_AUTOMATION_DAEMON,
                params,
                { retryOnDisconnect: true },
              );
            } catch (error) {
              return {
                ok: false,
                reason: (error as Error).message || "host_unreachable",
              };
            }
          },
        },
      });
      if (state.db !== db) {
        await cliBridgeServer.stop().catch(() => undefined);
        return;
      }
      state.cliBridgeServer = cliBridgeServer;
    };

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: deviceIdentity.deviceId,
      stellaAppDir: init.stellaAppDir,
      stellaDataDir: init.stellaDataDirPath,
      runtimeStore,
      getAppBrowserContext: async () =>
        (await peer.request(
          METHOD_NAMES.HOST_APP_BROWSER_CONTEXT_GET,
          undefined,
          {
            retryOnDisconnect: true,
          },
        )) as HostAppBrowserContextSnapshot,
      listLocalChatEvents: (conversationId, maxItems) =>
        chatStore.listEvents(conversationId, maxItems),
      recallReadQueries: {
        getFtsHealth: () => readRecallFtsHealth(db),
        listTranscriptNeighborsBatch: (targets, options) =>
          listTranscriptNeighborsBatch(db, targets, options),
      },
      appendLocalChatEvent: (args) => {
        const event = chatStore.appendEvent(args);
        notifyLocalChatUpdated(peer, args.conversationId, event);
      },
      notifyThreadActivityUpdated: (conversationId) => {
        peer.notify(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, {
          conversationId,
        });
      },
      getDefaultConversationId: () =>
        chatStore.getOrCreateDefaultConversationId(),
      requestCredential: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload, {
          retryOnDisconnect: true,
        }),
      requestBrowserExtensionConnect: (payload, signal) =>
        requestConnectCardFromHost(
          peer,
          METHOD_NAMES.HOST_BROWSER_EXTENSION_CONNECT_REQUEST,
          payload as Record<string, unknown>,
          signal,
        ),
      requestComputerUseAppApproval: async (payload) =>
        await peer.request(
          METHOD_NAMES.HOST_COMPUTER_USE_APP_APPROVAL_REQUEST,
          payload,
          { retryOnDisconnect: true },
        ),
      requestConnectorConnection: (payload, signal) =>
        requestConnectCardFromHost(
          peer,
          METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
          payload as Record<string, unknown>,
          signal,
        ),
      requestRuntimeAuthRefresh: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, payload, {
          retryOnDisconnect: true,
        }),
      scheduleApi: {
        listCronJobs: async () =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS,
            undefined,
            { retryOnDisconnect: true },
          ),
        addCronJob: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
            input,
            { retryOnDisconnect: true },
          ),
        updateCronJob: async (jobId, patch) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB,
            {
              jobId,
              patch,
            },
            { retryOnDisconnect: true },
          ),
        removeCronJob: async (jobId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        runCronJob: async (jobId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        getHeartbeatConfig: async (conversationId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
        upsertHeartbeat: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT,
            input,
            { retryOnDisconnect: true },
          ),
        runHeartbeat: async (conversationId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
      },
      // Store source mutation and application lifecycle were removed.
      stellaBrowserBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-browser",
        "stella-browser.js",
      ),
      stellaOfficeBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-office",
        "stella-office.js",
      ),
      stellaComputerCliPath: resolveRuntimeCliPath("stella-computer.js"),
      stellaMediaCliPath: resolveRuntimeCliPath("stella-media.js"),
      stellaXApiCliPath: resolveRuntimeCliPath("stella-x-api.js"),
      // The bridge listens in post-ready startup. Advertise the stable socket
      // path up front so shells spawned after the bridge comes online can call
      // back into the host without rebuilding the runner.
      ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
    };

    // Build the runner in the background instead of on the worker-ready path:
    // its module subgraph is ~68% of the bundle's eager parse and is only
    // needed once a turn runs. initializeWorker returns "ready" without awaiting
    // this; turn handlers join the same promise via ensureRunnerInitialized().
    // The dynamic import() is also what lets esbuild split the runner into its
    // own chunk (see dev-electron-build.mjs).
    const buildRunner = async (): Promise<RuntimeRunner> => {
      const { createStellaHostRunner } = await import("../kernel/runner.js");
      const runner = createStellaHostRunner(runnerOptions);
      // A re-init may have superseded this generation while the chunk imported.
      // `db` is replaced only on re-init (config patches keep it), so it's the
      // safe supersede token — discard rather than clobber the new generation.
      if (state.db !== db) {
        await runner.stop().catch(() => undefined);
        return runner;
      }
      // Apply the latest config (config patches that arrived during the import
      // no-op'd against a null state.runner, so re-apply from state.init).
      const cfg = state.init ?? init;
      runner.setConvexUrl(cfg.convexUrl);
      runner.setConvexSiteUrl(cfg.convexSiteUrl);
      runner.setAuthToken(cfg.authToken);
      runner.setHasConnectedAccount(cfg.hasConnectedAccount);
      runner.setCloudSyncEnabled(cfg.cloudSyncEnabled);
      runner.setModelCatalogUpdatedAt(cfg.modelCatalogUpdatedAt);
      state.runner = runner;
      runner.start();
      return runner;
    };
    state.runnerReadyError = null;
    const runnerReadyPromise = buildRunner().catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : String(error ?? "Runtime runner failed to start.");
      state.runnerReadyError = message;
      console.error("[runtime-worker] Runner failed to start:", message);
      throw error;
    });
    state.runnerReadyPromise = runnerReadyPromise;
    // Prevent an unobserved rejection from crashing the worker; real awaiters
    // (ensureRunnerInitialized / stopWorkerServices / the post-ready block)
    // surface the error.
    runnerReadyPromise.catch(() => undefined);

    const socialSessionService = new SocialSessionService({
      getWorkspaceRoot: () => init.stellaWorkspacePath,
      getDeviceId: () => state.deviceId,
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getStore: () => state.socialSessionStore,
      onLocalChatUpdated: () => {
        notifyLocalChatUpdated(peer);
      },
      pushDisplayPayload: (payload) => {
        // Forward the structured display payload through the existing
        // host display update bridge. The renderer normalizes it via
        // `normalizeDisplayPayload` and routes it to the workspace panel.
        void peer
          .request(
            METHOD_NAMES.HOST_DISPLAY_UPDATE,
            { payload },
            {
              retryOnDisconnect: true,
            },
          )
          .catch(() => undefined);
      },
    });
    socialSessionService.setConvexUrl(init.convexUrl);
    socialSessionService.setAuthToken(init.authToken);
    state.socialSessionService = socialSessionService;

    const userAppProjectService = new UserAppProjectService({
      workspacePath: init.stellaWorkspacePath,
      onChanged: () => {
        peer.notify(NOTIFICATION_NAMES.PROJECTS_UPDATED, undefined);
      },
    });
    await userAppProjectService.start();
    state.userAppProjectService = userAppProjectService;

    state.voiceService = new VoiceRuntimeService({
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getDeviceId: () => state.deviceId,
      onLocalChatUpdated: () => {
        notifyLocalChatUpdated(peer);
      },
      emitAgentEvent: (payload) => {
        emitVoiceAgentEvent(payload);
      },
    });

    const connectorSweep = await sweepStaleConnectorBridgeProcesses(
      init.stellaDataDirPath,
      { currentWorkerPid: process.pid },
    ).catch((error) => {
      console.warn(
        "[connector-bridge] Failed to sweep stale connector helpers:",
        (error as Error).message,
      );
      return null;
    });
    if (connectorSweep?.stopped) {
      console.warn(
        `[connector-bridge] Stopped ${connectorSweep.stopped} stale connector helper(s).`,
      );
    }
    // Connector-capable children may launch immediately after initialize
    // returns. The private bridge must therefore be listening and secured
    // before the worker reports ready; startup failures are fatal.
    return await afterRequiredCliBridgeReady(startCliBridge, () => {
      setTimeout(() => {
        void (async () => {
          const startupStartedAt = Date.now();
          // These post-ready warmups do not gate connector-capable child launch.
          await Promise.allSettled([
            (async () => runEventLogStartupBackfill())(),
            (async () => {
              const builtRunner = await runnerReadyPromise.catch(() => null);
              await builtRunner?.waitUntilInitialized().catch((error) => {
                console.warn(
                  "[runtime-worker] Runner initialization finished with an error:",
                  (error as Error).message,
                );
              });
            })(),
          ]);
          getFileLogger()?.process("startup.post-ready-complete", {
            ms: Date.now() - startupStartedAt,
          });
        })();
      }, 0);

      return {
        protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
        pid: process.pid,
        deviceId: state.deviceId,
      };
    });
  };

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
    async (params) => {
      // Subscribe before the runner loads extensions or models.json so every
      // successful initial/hot registry composition reaches the renderer.
      await ensureModelRuntimeSubscription();
      const result = await initializeWorker(
        params as WorkerInitializationState,
      );
      if (pendingConfigPatch) {
        applyConfigPatch(pendingConfigPatch);
        pendingConfigPatch = null;
      }
      // Warm the catalog against whatever config the worker initialized
      // with so a restart/reattach (module-level catalog cache is empty in
      // a fresh worker process) doesn't make the next chat pay the cold
      // fetch. Best-effort.
      scheduleModelCatalogWarm();
      return result;
    },
  );

  let pendingConfigPatch: Partial<WorkerInitializationState> | null = null;

  // Warm the Stella model catalog in the background whenever an input to its
  // cache key changes. The catalog cache is keyed by auth identity + device +
  // `modelCatalogUpdatedAt`. `modelCatalogUpdatedAt` is pushed down by the
  // renderer after it mounts, so the warm fired at worker init (under a
  // `null` updated-at) is followed by one under the real key once config
  // arrives — both off the open burst, since the worker itself now spawns
  // after first paint. Debounced so a `configure` call touching multiple
  // fields only warms once, and best-effort so a network failure never
  // affects config application.
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleModelCatalogWarm = () => {
    if (!state.runner) return;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      warmTimer = null;
      const warmStartedAt = Date.now();
      void state.runner
        ?.warmModelCatalog()
        .then(() => {
          getFileLogger()?.process("startup.catalog-warmed", {
            ms: Date.now() - warmStartedAt,
          });
        })
        .catch(() => undefined);
    }, 50);
  };

  const applyConfigPatch = (patch: Partial<WorkerInitializationState>) => {
    if (!state.init) return;
    state.init = { ...state.init, ...patch };
    if (patch.convexUrl !== undefined) {
      state.runner?.setConvexUrl(patch.convexUrl);
      state.socialSessionService?.setConvexUrl(patch.convexUrl);
    }
    if (patch.convexSiteUrl !== undefined) {
      state.runner?.setConvexSiteUrl(patch.convexSiteUrl);
    }
    if (patch.authToken !== undefined) {
      state.runner?.setAuthToken(patch.authToken);
      state.socialSessionService?.setAuthToken(patch.authToken);
    }
    if (patch.hasConnectedAccount !== undefined) {
      state.runner?.setHasConnectedAccount(patch.hasConnectedAccount);
    }
    if (patch.cloudSyncEnabled !== undefined) {
      state.runner?.setCloudSyncEnabled(patch.cloudSyncEnabled);
    }
    if (patch.modelCatalogUpdatedAt !== undefined) {
      state.runner?.setModelCatalogUpdatedAt(patch.modelCatalogUpdatedAt);
    }
    // Auth identity and the catalog version are the two cache-key inputs
    // the runtime controls; re-warm when either moves.
    if (
      patch.authToken !== undefined ||
      patch.modelCatalogUpdatedAt !== undefined
    ) {
      scheduleModelCatalogWarm();
    }
  };

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CONFIGURE,
    async (params) => {
      const patch = params as Partial<WorkerInitializationState>;
      if (!state.init) {
        // Queue the patch — it will be applied after initialization
        pendingConfigPatch = { ...pendingConfigPatch, ...patch };
        return { ok: true, queued: true };
      }
      applyConfigPatch(patch);
      if (patch.localLlmCredentialsUpdatedAt !== undefined) {
        await refreshLocalLlmCredentialAccess();
      }
      return { ok: true };
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_HEALTH, async () => {
    const health =
      state.runner?.agentHealthCheck() ??
      ({
        ready: false,
        ...(state.runnerReadyError
          ? { reason: state.runnerReadyError }
          : { reason: "Stella runtime is still initializing" }),
      } satisfies AgentHealth);
    const socialSessions =
      state.socialSessionService?.getSnapshot() ??
      createEmptySocialSessionServiceSnapshot();
    const activeRun =
      state.runner?.getActiveOrchestratorRun() ??
      state.runner?.listActiveAgentRuns()[0] ??
      null;
    return {
      health,
      activeRun,
      activeAgentCount: state.runner?.getActiveAgentCount() ?? 0,
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
      pid: process.pid,
      deviceId: state.deviceId,
      voiceBusy: state.voiceService?.isBusy() ?? false,
      pendingVoiceRequestCount:
        state.voiceService?.getPendingRequestCount() ?? 0,
      socialSessions,
    };
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS,
    async (params) => {
      const modelRuntime = await ensureModelRuntimeSubscription();
      const forceRefresh =
        Boolean(params) &&
        typeof params === "object" &&
        (params as { forceRefresh?: unknown }).forceRefresh === true;
      return await modelRuntime.getSnapshotForListing({ forceRefresh });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE,
    async () => {
      // Tolerate the runner still building (post-ready window): no runner ⇒ no
      // active run.
      return state.runner?.getActiveOrchestratorRun() ?? null;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_START_CHAT,
    async (params) => {
      const payload = params as RuntimeChatPayload;
      const assistantWorkingMode: AssistantWorkingMode = state.init
        ? getAssistantWorkingMode(state.init.stellaDataDirPath)
        : "direct";
      const requestId =
        asTrimmedString(
          (payload as RuntimeChatPayload & { requestId?: string }).requestId,
        ) || undefined;
      // Resolve the provider/model this turn will run on so composer images are
      // sized to that provider's real limits (best-effort; falls back to the
      // safe conservative profile when no route resolves).
      let composerImageTarget: ImageCapTarget | undefined;
      try {
        composerImageTarget =
          (await (
            await ensureRunnerInitialized()
          ).resolveImageTarget(payload.agentType)) ?? undefined;
      } catch {
        composerImageTarget = undefined;
      }
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
        composerImageTarget,
      );
      let modelImageAttachments = materializedImageAttachments.map(
        ({ attachment }) => attachment,
      );
      let persistedImageAttachments: SpilledImageAttachment[] = [];
      if (modelImageAttachments.length > 0) {
        if (!state.init) {
          throw new Error("Worker has not been initialized.");
        }
        persistedImageAttachments = await spillImageAttachmentsToDisk({
          stellaDataDirPath: state.init.stellaDataDirPath,
          conversationId: payload.conversationId,
          attachments: modelImageAttachments,
        });
        modelImageAttachments = attachPersistedImagePaths(
          modelImageAttachments,
          persistedImageAttachments,
        );
      }
      const totalInlineImageBytes = modelImageAttachments.reduce(
        (total, attachment) => total + approximateDataUrlBytes(attachment.url),
        0,
      );
      let spilledImageAttachments: SpilledImageAttachment[] = [];
      const hasOverCapInlineImage = modelImageAttachments.some(
        (attachment) =>
          dataUrlBase64Length(attachment.url) > MAX_INLINE_IMAGE_BASE64_BYTES,
      );
      if (
        totalInlineImageBytes > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES ||
        hasOverCapInlineImage
      ) {
        spilledImageAttachments = persistedImageAttachments;
        modelImageAttachments = [];
      }
      const { buildChatPromptMessages } = await loadChatPromptContext();
      const {
        visibleUserPrompt,
        windowContextLabel,
        browserUrl,
        appSelectionLabel,
        appSelectionLabels,
        activityLabel,
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: modelImageAttachments.length,
      });
      let modelWindowScreenshotAttachment = windowScreenshotAttachment;
      if (modelWindowScreenshotAttachment) {
        if (!state.init) {
          throw new Error("Worker has not been initialized.");
        }
        const persistedWindowScreenshot = await spillImageAttachmentsToDisk({
          stellaDataDirPath: state.init.stellaDataDirPath,
          conversationId: payload.conversationId,
          attachments: [modelWindowScreenshotAttachment],
        });
        [modelWindowScreenshotAttachment] = attachPersistedImagePaths(
          [modelWindowScreenshotAttachment],
          persistedWindowScreenshot,
        );
      }
      const runPromptMessages: RuntimePromptMessage[] = [
        ...(promptMessages ?? []),
        ...(spilledImageAttachments.length > 0
          ? [
              {
                text: buildSpilledAttachmentNotice(spilledImageAttachments),
                uiVisibility: "hidden" as const,
                messageType: "message" as const,
                customType: "runtime.chat_context",
              },
            ]
          : []),
      ];
      const userMessageTimestamp =
        typeof payload.userMessageTimestamp === "number" &&
        Number.isFinite(payload.userMessageTimestamp)
          ? payload.userMessageTimestamp
          : Date.now();
      const windowPreviewImageUrl = windowScreenshotAttachment?.url;
      const userMessageId =
        payload.userMessageEventId ?? `local:${crypto.randomUUID()}`;
      let userMessageEventAppended = false;
      const appendUserMessageEvent = (timestamp = userMessageTimestamp) => {
        if (userMessageEventAppended) {
          return;
        }
        userMessageEventAppended = true;
        const userMessageEvent = ensureChatStore().appendEvent({
          conversationId: payload.conversationId,
          type: "user_message",
          eventId: userMessageId,
          deviceId: payload.deviceId,
          timestamp,
          payload: prepareStoredLocalChatPayload({
            type: "user_message",
            payload: {
              text: visibleUserPrompt,
              // Store the display copy preview-weight: full-resolution data
              // URLs are for the model request only — persisting them here
              // bloats the chat store and makes every render of the user
              // row decode the originals.
              ...(payload.attachments?.length
                ? {
                    attachments: payload.attachments.map(
                      ({ previewUrl, ...attachment }) => ({
                        ...attachment,
                        ...(previewUrl ? { url: previewUrl } : {}),
                      }),
                    ),
                  }
                : {}),
              ...(payload.platform ? { platform: payload.platform } : {}),
              ...(payload.timezone ? { timezone: payload.timezone } : {}),
              ...(payload.locale ? { locale: payload.locale } : {}),
              ...(payload.messageMetadata ||
              windowContextLabel ||
              browserUrl ||
              appSelectionLabel ||
              activityLabel ||
              windowPreviewImageUrl
                ? {
                    metadata: {
                      ...(payload.messageMetadata ?? {}),
                      ...(windowContextLabel ||
                      browserUrl ||
                      appSelectionLabel ||
                      activityLabel ||
                      windowPreviewImageUrl
                        ? {
                            context: {
                              ...(payload.messageMetadata?.context ?? {}),
                              ...(windowContextLabel
                                ? {
                                    windowLabel: windowContextLabel,
                                  }
                                : {}),
                              ...(browserUrl
                                ? {
                                    browserUrl,
                                  }
                                : {}),
                              ...(windowPreviewImageUrl
                                ? {
                                    windowPreviewImageUrl,
                                  }
                                : {}),
                              ...(appSelectionLabel
                                ? {
                                    appSelectionLabel,
                                  }
                                : {}),
                              ...(appSelectionLabels?.length
                                ? {
                                    appSelectionLabels,
                                  }
                                : {}),
                              ...(activityLabel
                                ? {
                                    activityLabel,
                                  }
                                : {}),
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(payload.mode ? { mode: payload.mode } : {}),
            },
            timestamp,
            timezone: payload.timezone,
          }),
        });
        notifyLocalChatUpdated(peer, payload.conversationId, userMessageEvent);
      };
      if (payload.mode !== "follow_up") {
        appendUserMessageEvent();
      }

      const createSyntheticSeq = () => {
        let seq = Date.now();
        return () => {
          seq += 1;
          return seq;
        };
      };
      let activeRunId = "";
      const nextSyntheticSeq = createSyntheticSeq();
      const hiddenSystemRunIds = new Set<string>();
      let lastVisibleRunId = "";
      let lastVisibleRequestId = requestId;
      const hasActiveAgentForRootRun = (runId: string | undefined): boolean => {
        if (!runId) return false;
        return (
          state.runner
            ?.listActiveAgentRuns()
            .some((agentRun) => agentRun.runId === runId) ?? false
        );
      };
      /**
       * Tracks the most-recently persisted orchestrator assistant message for
       * this run. Successful completion patches this final segment with the
       * durable turn-complete receipt used to retire direct-mode preambles.
       */
      let lastAssistantMessageEvent: LocalChatEventRecord | null = null;
      /**
       * Worker-clock time of the CURRENT assistant segment's first stream
       * chunk, per run. Set on the first `onStream` chunk after a segment
       * boundary, consumed (and cleared) by `onAssistantMessage` so the
       * persisted row carries `metadata.runtime.streamStartedAtMs` — the
       * chronological anchor the renderer uses to place lifecycle cards
       * before/after this text block.
       */
      const segmentFirstChunkAtMsByRunId = new Map<string, number>();
      const mergedAttachments = [
        ...modelImageAttachments,
        ...(modelWindowScreenshotAttachment
          ? [modelWindowScreenshotAttachment]
          : []),
      ];
      logger.info("startChat.prompt-shape", {
        conversationId: payload.conversationId,
        visibleUserPrompt,
        windowContextLabel,
        appSelectionLabel,
        activityLabel,
        promptMessages: runPromptMessages.map((message, index) => ({
          index,
          uiVisibility: message.uiVisibility ?? "visible",
          textPreview: message.text.slice(0, 200),
        })),
        incomingAttachmentCount: payload.attachments?.length ?? 0,
        modelImageAttachmentCount: modelImageAttachments.length,
        mergedAttachmentCount: mergedAttachments.length,
        totalInlineImageBytes,
        spilledImageAttachmentCount: spilledImageAttachments.length,
        hasWindowScreenshotAttachment: Boolean(windowScreenshotAttachment),
      });
      const result = await (
        await ensureRunnerInitialized()
      ).handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId,
          userPrompt: visibleUserPrompt,
          ...(runPromptMessages.length
            ? { promptMessages: runPromptMessages }
            : {}),
          attachments:
            mergedAttachments.length > 0 ? mergedAttachments : undefined,
          agentType: payload.agentType,
          storageMode: payload.storageMode,
        },
        {
          onAssistantMessage: (ev) => {
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) !==
              AGENT_IDS.ORCHESTRATOR
            ) {
              return;
            }
            const streamStartedAtMs = segmentFirstChunkAtMsByRunId.get(
              ev.runId,
            );
            segmentFirstChunkAtMsByRunId.delete(ev.runId);
            const assistantEvent = appendAssistantMessageForTurn({
              conversationId: payload.conversationId,
              text: ev.text,
              userMessageId: ev.userMessageId,
              runId: ev.runId,
              seq: ev.seq,
              timezone: payload.timezone,
              workingMode: assistantWorkingMode,
              ...(ev.followedByToolCall ? { followedByToolCall: true } : {}),
              responseTarget: ev.responseTarget,
              ...(streamStartedAtMs !== undefined ? { streamStartedAtMs } : {}),
            });
            if (assistantEvent) {
              lastAssistantMessageEvent = assistantEvent;
            }
            // Boundary marker on the same wire as `STREAM` chunks so the
            // renderer can reset its in-flight streaming buffer before
            // chunks for the next assistant message in this run arrive
            // (e.g. post-tool answer after a preamble). Without this the
            // buffer keeps growing across messages and the live stream
            // row replays the preamble text under the next message's
            // content.
            //
            // Use the recorder's own seq for this event (`ev.seq`) — the
            // renderer's per-conversation seq guard drops any event whose
            // seq is `<= previousSeq`. A `Date.now()`-style synthetic seq
            // here would clobber the cursor with a huge number and silently
            // drop every subsequent small-seq STREAM chunk in the run
            // (the post-tool answer would stop streaming live). For the
            // rare hidden→visible mirror path the boundary seq has to
            // belong to the visible run's cursor; fall back to a
            // synthetic value there since the visible recorder is not
            // reachable from this closure.
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            const targetRunId = isHiddenRun ? lastVisibleRunId : ev.runId;
            const targetRequestId = isHiddenRun
              ? lastVisibleRequestId
              : requestId;
            const boundarySeq = isHiddenRun ? nextSyntheticSeq() : ev.seq;
            if (targetRunId) {
              emitRunEvent({
                type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
                runId: targetRunId,
                seq: boundarySeq,
                conversationId: payload.conversationId,
                ...(targetRequestId ? { requestId: targetRequestId } : {}),
                userMessageId: ev.userMessageId,
                agentType: ev.agentType,
                ...(assistantEvent
                  ? { assistantMessageEventId: assistantEvent._id }
                  : {}),
                assistantMessageText: ev.text,
                ...(ev.responseTarget
                  ? { responseTarget: ev.responseTarget }
                  : {}),
                // Preamble → tool-call handoff: when this finalized message
                // ends with a tool call, the renderer keeps the working
                // indicator up across the gap until the tool starts, instead
                // of dismissing on the painted preamble text.
                ...(ev.followedByToolCall ? { followedByToolCall: true } : {}),
              });
            }
          },
          onRunStarted: (ev) => {
            activeRunId = ev.runId;
            if (ev.userMessageId === userMessageId) {
              appendUserMessageEvent();
            }
            const isHiddenRun = ev.uiVisibility === "hidden";
            if (isHiddenRun) {
              hiddenSystemRunIds.add(ev.runId);
              if (lastVisibleRunId && ev.responseTarget) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
                  conversationId: payload.conversationId,
                  uiVisibility: "visible",
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            lastVisibleRunId = ev.runId;
            lastVisibleRequestId = requestId;
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onUserMessage: (ev) => {
            if (ev.uiVisibility === "hidden") {
              return;
            }
            const event = ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "user_message",
              requestId: ev.userMessageId,
              timestamp: ev.timestamp,
              payload: prepareStoredLocalChatPayload({
                type: "user_message",
                payload: {
                  text: ev.text,
                  metadata: {
                    ui: {
                      visibility: ev.uiVisibility ?? "visible",
                    },
                  },
                },
                timestamp: ev.timestamp,
                timezone: payload.timezone,
              }),
            });
            notifyLocalChatUpdated(peer, payload.conversationId, event);
          },
          onStream: (ev) => {
            if (ev.chunk && !segmentFirstChunkAtMsByRunId.has(ev.runId)) {
              segmentFirstChunkAtMsByRunId.set(ev.runId, Date.now());
            }
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.STREAM,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.STREAM,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onStatus: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.STATUS,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.STATUS,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onToolStart: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              return;
            }
            const event = ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "tool_request",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                ...(ev.args ? { args: ev.args } : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
            notifyLocalChatUpdated(peer, payload.conversationId, event);
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onToolEnd: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              return;
            }
            const details =
              ev.details && typeof ev.details === "object"
                ? (ev.details as Record<string, unknown>)
                : undefined;
            const event = ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "tool_result",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                result: details ?? ev.resultPreview,
                resultPreview: ev.resultPreview,
                ...(details ? details : {}),
                ...(ev.fileChanges?.length
                  ? { fileChanges: ev.fileChanges }
                  : {}),
                ...(ev.producedFiles?.length
                  ? { producedFiles: ev.producedFiles }
                  : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
                // Attributes the tool result to a spawned agent's thread so
                // per-agent file lists (left sidebar Activity tray) can pick
                // up file changes live, before `agent-completed` rolls up.
                ...(ev.agentId ? { agentId: ev.agentId } : {}),
              },
            });
            notifyLocalChatUpdated(peer, payload.conversationId, event);
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onError: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                if (hasActiveAgentForRootRun(lastVisibleRunId)) {
                  return;
                }
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  reason: ev.error,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
                AGENT_IDS.ORCHESTRATOR &&
              hasActiveAgentForRootRun(ev.runId)
            ) {
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
              reason: ev.error,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              ...(ev.runId ? { rootRunId: ev.runId } : {}),
            });
          },
          onAgentEvent: (ev) => {
            if (!ev.rootRunId) {
              logger.warn("task-event-missing-root-run-id", {
                conversationId: ev.conversationId,
                agentId: ev.agentId,
                type: ev.type,
              });
              return;
            }
            if (
              ev.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED &&
              ev.agentType === AGENT_IDS.GENERAL
            ) {
              const notificationText =
                ev.description?.trim() || "Task complete";
              void peer
                .request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
                  title: notificationText,
                  body: "",
                  sound: "Glass",
                })
                .catch((error) => {
                  logger.debug("agent-completion-notification-failed", {
                    conversationId: payload.conversationId,
                    agentId: ev.agentId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                });
            }
            emitRunEvent({
              type: ev.type,
              runId: ev.rootRunId,
              seq: nextSyntheticSeq(),
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              userMessageId,
              agentId: ev.agentId,
              rootRunId: ev.rootRunId,
              agentType: ev.agentType,
              description: ev.description,
              parentAgentId: ev.parentAgentId,
              result: ev.result,
              error: ev.error,
              statusText: ev.statusText,
              ...(ev.toolActivity ? { toolActivity: ev.toolActivity } : {}),
              ...(ev.groupKey ? { groupKey: ev.groupKey } : {}),
              ...(ev.groupLabel ? { groupLabel: ev.groupLabel } : {}),
            });
          },
          onAgentReasoning: (ev) => {
            if (!ev.agentId) {
              return;
            }
            const runId = ev.rootRunId ?? ev.runId;
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
              runId,
              seq: nextSyntheticSeq(),
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              userMessageId,
              agentId: ev.agentId,
              rootRunId: runId,
              agentType: ev.agentType,
              ...(ev.description ? { description: ev.description } : {}),
              chunk: ev.chunk,
            });
          },
          onEnd: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
              AGENT_IDS.ORCHESTRATOR
            ) {
              // Each assistant message in the run was already persisted
              // by `onAssistantMessage` as its own row, so end-of-run no
              // longer writes a new row from `finalText` (doing so would
              // append a duplicate of the last message).
              // Mark only the last segment terminal. In direct mode the
              // renderer uses that receipt to remove earlier preamble text
              // after the successful turn has actually finished.
              lastAssistantMessageEvent = markAssistantTurnComplete({
                conversationId: payload.conversationId,
                event: lastAssistantMessageEvent,
              });
            }
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              ...(ev.runId ? { rootRunId: ev.runId } : {}),
            });
          },
          onInterrupted: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  runId: lastVisibleRunId,
                  seq: Number.MAX_SAFE_INTEGER,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  agentType: ev.agentType,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
                  reason: ev.reason,
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              runId: ev.runId,
              seq: Number.MAX_SAFE_INTEGER,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              agentType: ev.agentType,
              userMessageId: ev.userMessageId,
              outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
              reason: ev.reason,
              rootRunId: ev.runId,
            });
          },
        },
      );
      activeRunId = result.runId;
      return { ...result, userMessageId };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        threadId?: string;
        message?: string;
        metadata?: Record<string, unknown>;
      };
      const conversationId = asTrimmedString(payload.conversationId);
      const threadId = asTrimmedString(payload.threadId);
      const message = asTrimmedString(payload.message);
      if (!conversationId) {
        throw new Error("conversationId is required.");
      }
      if (!threadId) {
        throw new Error("threadId is required.");
      }
      if (!message) {
        throw new Error("message is required.");
      }

      const delivered = await (
        await ensureRunnerInitialized()
      ).executeTool(
        "send_input",
        {
          thread_id: threadId,
          message,
        },
        {
          conversationId,
          deviceId: state.deviceId ?? "local",
          requestId: `agent-input:${crypto.randomUUID()}`,
          agentType: AGENT_IDS.ORCHESTRATOR,
          storageMode: "local",
        },
      );
      if (delivered.error) {
        throw new Error(delivered.error);
      }

      const metadata =
        payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : {};
      const uiMetadata =
        metadata.ui && typeof metadata.ui === "object"
          ? (metadata.ui as Record<string, unknown>)
          : {};
      const timestamp = Date.now();
      const event = ensureChatStore().appendEvent({
        conversationId,
        type: "user_message",
        timestamp,
        payload: prepareStoredLocalChatPayload({
          type: "user_message",
          payload: {
            text: message,
            metadata: {
              ...metadata,
              ui: {
                ...uiMetadata,
                visibility: "hidden",
              },
            },
          },
          timestamp,
        }),
      });
      notifyLocalChatUpdated(peer, conversationId, event);
      return { delivered: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CANCEL,
    async (params) => {
      // Tolerate the runner still building (post-ready window): nothing to
      // cancel if it hasn't started yet.
      state.runner?.cancelLocalChat((params as { runId: string }).runId);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION,
    async (params) => {
      const cancelled =
        state.runner?.cancelLocalChatByConversation(
          (params as { conversationId: string }).conversationId,
        ) ?? false;
      return { ok: true, cancelled };
    },
  );

  // Worker-side replay: read everything past `lastSeq` for `runId` from
  // the persistent ring buffer. This is the path Electron takes after a
  // restart — by the time the host reconnects, the in-memory host buffer
  // is gone but the worker still has every event.
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS,
    async (params) => {
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : 0;
      const log = state.runEventLog;
      if (!log) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const result = log.resumeAfter({ runId, lastSeq });
      const events = result.events.map(
        (record) => record.payload as unknown as AgentEventPayload,
      );
      return { events, exhausted: result.exhausted };
    },
  );

  // Host ack — every event the host successfully forwards to the renderer
  // gets acked back so the worker can prune. Best-effort: under-acking
  // just retains rows longer; over-acking before the renderer actually
  // saw an event would lose it on reconnect, so the host should only
  // ack after `webContents.send` resolves.
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS,
    async (params) => {
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : Number.NaN;
      if (!runId || !Number.isFinite(lastSeq)) {
        return { pruned: 0 };
      }
      const pruned = state.runEventLog?.ack({ runId, lastSeq }) ?? 0;
      return { pruned };
    },
  );

  // Probe used by a reconnecting host to discover which runs are still
  // worth subscribing to — combines the live runner's active run with
  // retained event-log rows (a run that just completed but whose terminal
  // event hasn't been acked is still resumable).
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS,
    async () => {
      const runner = state.runner;
      const activeRun = runner?.getActiveOrchestratorRun() ?? null;
      const activeAgentRuns = runner?.listActiveAgentRuns() ?? [];
      const result: Array<{
        runId: string;
        conversationId: string;
        kind: "active" | "buffered";
        uiVisibility?: "visible" | "hidden";
      }> = [];
      const seenRunIds = new Set<string>();
      if (activeRun) {
        result.push({
          runId: activeRun.runId,
          conversationId: activeRun.conversationId,
          kind: "active",
        });
        seenRunIds.add(activeRun.runId);
      }
      for (const agentRun of activeAgentRuns) {
        if (seenRunIds.has(agentRun.runId)) continue;
        result.push({
          runId: agentRun.runId,
          conversationId: agentRun.conversationId,
          kind: "active",
          uiVisibility: "hidden",
        });
        seenRunIds.add(agentRun.runId);
      }
      const activeRunId = activeRun?.runId ?? null;
      for (const buffered of state.runEventLog?.listBufferedRuns() ?? []) {
        if (buffered.runId === activeRunId || seenRunIds.has(buffered.runId)) {
          continue;
        }
        result.push({
          runId: buffered.runId,
          conversationId: buffered.conversationId,
          kind: "buffered",
        });
      }
      return { runs: result };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
    async (params) => {
      const payload = params as {
        conversationId: string;
        userPrompt: string;
        agentType?: string;
        modelOverride?: string;
        toolWorkspaceRoot?: string;
        attachments?: RuntimeAttachmentRef[];
        connectorDeliveryTarget?: {
          requestId: string;
          conversationId: string;
          provider?: string;
          externalMessageId?: string;
        };
      };
      let automationImageTarget: ImageCapTarget | undefined;
      try {
        automationImageTarget =
          (await (
            await ensureRunnerInitialized()
          ).resolveImageTarget(payload.agentType)) ?? undefined;
      } catch {
        automationImageTarget = undefined;
      }
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
        automationImageTarget,
      );
      return await (
        await ensureRunnerInitialized()
      ).runAutomationTurn({
        ...payload,
        ...(materializedImageAttachments.length > 0
          ? {
              attachments: materializedImageAttachments.map(
                ({ attachment }) => attachment,
              ),
            }
          : {}),
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT,
    async (params) => {
      const payload = params as RuntimeLocalAgentRequest;
      return await (
        await ensureRunnerInitialized()
      ).runBlockingLocalAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT,
    async (params) => {
      const payload = params as RuntimeLocalAgentRequest;
      return await (
        await ensureRunnerInitialized()
      ).createBackgroundAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT,
    async (params) => {
      // Tolerate the runner still building (post-ready window): a fresh worker
      // has no in-memory agent yet, so a missing snapshot is the right answer.
      return state.runner
        ? await state.runner.getLocalAgentSnapshot(
            (params as { agentId: string }).agentId,
          )
        : null;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE,
    async (params) => {
      // Don't drop the message if the runner is still building (post-ready
      // window) — wait for the background build, then append.
      await joinRunnerBuild();
      ensureRunner().appendThreadMessage(
        params as {
          threadKey: string;
          role: "user" | "assistant";
          content: string;
        },
      );
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH,
    async (params) => {
      const payload = params as {
        query: string;
        category?: string;
      };
      return await (
        await ensureRunnerInitialized()
      ).webSearch(payload.query, {
        category: payload.category,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT,
    async (params) => {
      return ensureVoiceService().persistTranscript(
        params as {
          conversationId: string;
          role: "user" | "assistant";
          text: string;
          uiVisibility?: "visible" | "hidden";
          voiceSession?: { durationMs: number };
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT,
    async (params) => {
      return await ensureVoiceService().orchestratorChat(
        params as {
          requestId: string;
          conversationId: string;
          message: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG,
    async (params) => {
      return await ensureVoiceService().getOrchestratorConfig(
        params as {
          conversationId: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL,
    async (params) => {
      return await ensureVoiceService().executeTool(
        params as RuntimeVoiceToolCallPayload,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH,
    async (params) => {
      return await ensureVoiceService().webSearch(
        params as {
          query: string;
          category?: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES,
    async () => {
      return await ensureRunner().listStorePackages();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE,
    async (params) => {
      return await ensureRunner().getStorePackage(
        (params as { packageId: string }).packageId,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES,
    async (params) => {
      return await ensureRunner().listStorePackageReleases(
        (params as { packageId: string }).packageId,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE,
    async (params) => {
      const payload = params as { packageId: string; releaseNumber: number };
      return await ensureRunner().getStorePackageRelease(
        payload.packageId,
        payload.releaseNumber,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS,
    async () => {
      ensureRunner().killAllShells();
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    async () => {
      return ensureChatStore().getOrCreateDefaultConversationId();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT,
    async (params) => {
      const eventArgs = params as {
        conversationId: string;
        type: string;
        payload?: unknown;
        requestId?: string;
        targetDeviceId?: string;
        deviceId?: string;
        timestamp?: number;
        eventId?: string;
        channelEnvelope?: unknown;
      };
      const event = ensureChatStore().appendEvent(eventArgs);
      notifyLocalChatUpdated(peer, eventArgs.conversationId, event);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        maxItems?: number;
      };
      return ensureChatStore().listEvents(
        payload.conversationId ?? "",
        payload.maxItems,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT,
    async (params) => {
      const payload = params as { conversationId?: string };
      return ensureChatStore().getEventCount(payload.conversationId ?? "");
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        message?: string;
        firstReport?: unknown;
      };
      const conversationId = payload.conversationId ?? "";
      const message =
        typeof payload.message === "string" ? payload.message : "";
      let latestEvent: LocalChatEventRecord | undefined;
      if (message.trim().length > 0) {
        latestEvent = ensureChatStore().appendEvent({
          conversationId,
          type: "assistant_message",
          payload: prepareStoredLocalChatPayload({
            type: "assistant_message",
            payload: { text: message },
            timestamp: Date.now(),
          }),
        });
      }
      const firstReport =
        payload.firstReport &&
        typeof payload.firstReport === "object" &&
        !Array.isArray(payload.firstReport)
          ? (payload.firstReport as Record<string, unknown>)
          : null;
      const reportTitle =
        typeof firstReport?.title === "string" ? firstReport.title.trim() : "";
      const reportHtml =
        typeof firstReport?.html === "string" ? firstReport.html : "";
      if (reportTitle && reportHtml.trim() && state.init?.stellaDataDirPath) {
        const rawSlug =
          typeof firstReport?.slug === "string" ? firstReport.slug : "";
        const slug =
          rawSlug
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "welcome";
        const timestamp = Date.now();
        const filePath = path.join(
          state.init.stellaDataDirPath,
          "outputs",
          "html",
          `${slug}.html`,
        );
        let kind: "add" | "update" = "add";
        try {
          await fsPromises.access(filePath);
          kind = "update";
        } catch {
          kind = "add";
        }
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, reportHtml, "utf8");
        const bytes = Buffer.byteLength(reportHtml, "utf8");
        latestEvent = ensureChatStore().appendEvent({
          conversationId,
          type: "tool_result",
          requestId: `onboarding-first-report-${timestamp}`,
          timestamp: timestamp + 1,
          payload: {
            toolName: "html",
            result: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
            resultPreview: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
            details: {
              filePath,
              slug,
              title: reportTitle,
              createdAt: timestamp,
              bytes,
            },
            filePath,
            slug,
            title: reportTitle,
            createdAt: timestamp,
            bytes,
            fileChanges: [fileChange(filePath, { type: kind })],
            agentType: AGENT_IDS.ORCHESTRATOR,
          },
        });
      }
      notifyLocalChatUpdated(peer, conversationId, latestEvent);
      return { ok: true as const };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        maxMessages?: number;
      };
      return ensureChatStore().listSyncMessages(
        payload.conversationId ?? "",
        payload.maxMessages,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT,
    async (params) => {
      return ensureChatStore().getSyncCheckpoint(
        (params as { conversationId?: string }).conversationId ?? "",
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        localMessageId?: string;
      };
      ensureChatStore().setSyncCheckpoint(
        payload.conversationId ?? "",
        payload.localMessageId ?? "",
      );
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload =
        (params as
          | { selectedBrowser?: string; selectedProfile?: string }
          | undefined) ?? {};
      const data = await collectBrowserData(state.init.stellaDataDirPath, {
        selectedBrowser: payload.selectedBrowser as
          | import("../discovery/browser-data.js").BrowserType
          | undefined,
        selectedProfile: payload.selectedProfile,
      });
      return { data, formatted: formatBrowserDataForSynthesis(data) };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload =
        (params as
          | {
              categories?: string[];
              selectedBrowser?: string;
              selectedProfile?: string;
            }
          | undefined) ?? {};
      return await collectAllSignals(
        state.init.stellaDataDirPath,
        payload.categories as
          | import("@stella/contracts/discovery").DiscoveryCategory[]
          | undefined,
        payload.selectedBrowser,
        payload.selectedProfile,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as { roomId?: string; workspaceLabel?: string };
      const roomId = asTrimmedString(payload?.roomId);
      if (!roomId) {
        throw new Error("Room ID is required.");
      }
      return await state.socialSessionService.createSession({
        roomId,
        workspaceLabel: asTrimmedString(payload?.workspaceLabel) || undefined,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as {
        sessionId?: string;
        status?: "active" | "paused" | "ended";
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      if (!sessionId) {
        throw new Error("Session ID is required.");
      }
      const status = payload?.status;
      if (status !== "active" && status !== "paused" && status !== "ended") {
        throw new Error("Session status is invalid.");
      }
      return await state.socialSessionService.updateSessionStatus({
        sessionId,
        status,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as {
        sessionId?: string;
        prompt?: string;
        agentType?: string;
        clientTurnId?: string;
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      const prompt = asTrimmedString(payload?.prompt);
      if (!sessionId) {
        throw new Error("Session ID is required.");
      }
      if (!prompt) {
        throw new Error("Prompt is required.");
      }
      return await state.socialSessionService.queueTurn({
        sessionId,
        prompt,
        agentType: asTrimmedString(payload?.agentType) || undefined,
        clientTurnId: asTrimmedString(payload?.clientTurnId) || undefined,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS,
    async () => {
      return (
        state.socialSessionService?.getSnapshot() ??
        createEmptySocialSessionServiceSnapshot()
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PROJECTS_LIST,
    async () => {
      if (!state.userAppProjectService) {
        throw new Error("User app project service is unavailable.");
      }
      return await state.userAppProjectService.list();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PROJECTS_START,
    async (params) => {
      if (!state.userAppProjectService) {
        throw new Error("User app project service is unavailable.");
      }
      const slug = asTrimmedString((params as { slug?: unknown })?.slug);
      return await state.userAppProjectService.startProject(slug);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PROJECTS_STOP,
    async (params) => {
      if (!state.userAppProjectService) {
        throw new Error("User app project service is unavailable.");
      }
      const slug = asTrimmedString((params as { slug?: unknown })?.slug);
      return await state.userAppProjectService.stopProject(slug);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT,
    async (params) => {
      ensureRunner().killShellsByPort((params as { port: number }).port);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS,
    async () => {
      return await ensureRunner().googleWorkspaceGetAuthStatus();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT,
    async () => {
      return await ensureRunner().googleWorkspaceConnect();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT,
    async () => {
      return await ensureRunner().googleWorkspaceDisconnect();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION,
    async (params): Promise<RuntimeOneShotCompletionResult> => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const init = state.init;
      const request = params as RuntimeOneShotCompletionRequest;
      return await (
        await loadOneShotCompletion()
      ).runOneShotCompletion({
        request,
        runtime: {
          stellaAppDir: init.stellaAppDir,
          stellaDataDir: init.stellaDataDirPath,
          siteBaseUrl: init.convexSiteUrl,
          getAuthToken: () => init.authToken,
          hasConnectedAccount: () => state.init?.hasConnectedAccount ?? false,
          requestRuntimeAuthRefresh: async () => {
            try {
              return (await peer.request(
                METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
                { source: "stella_provider" },
                { retryOnDisconnect: true },
              )) as {
                authenticated: boolean;
                token: string | null;
                hasConnectedAccount: boolean;
              };
            } catch {
              return null;
            }
          },
        },
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW,
    async (params) => {
      const trigger =
        (params as { trigger?: "manual" | "startup_catchup" } | undefined)
          ?.trigger ?? "manual";
      return await ensureRunner().triggerDreamNow(trigger);
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_HEALTH, async () => {
    const activeRun =
      state.runner?.getActiveOrchestratorRun() ??
      state.runner?.listActiveAgentRuns()[0] ??
      null;
    return {
      ready: Boolean(state.runner?.agentHealthCheck().ready),
      hostPid: process.pid,
      workerPid: process.pid,
      workerRunning: true,
      workerGeneration: 0,
      deviceId: state.deviceId,
      activeRunId: activeRun?.runId ?? null,
      activeAgentCount: state.runner?.getActiveAgentCount() ?? 0,
    };
  });

  const shutdownWorker = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    unsubscribeFromModelCatalog?.();
    unsubscribeFromModelCatalog = undefined;
    await stopWorkerServices(state);
  };

  return {
    hasActiveWork,
    shutdown: shutdownWorker,
  };
};
