import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { useMutation, useQuery } from "convex/react";
import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
} from "../components/working-indicator-state";
import type { ChatArtifact } from "../types";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import {
  mergeCanonicalCloudTasks,
  projectCloudAgentThreads,
  resolveCloudAgentThreadQueryArgs,
  selectScopedCloudOperationalTasks,
  type CloudOperationalTaskScope,
  type ScopedCloudOperationalTasks,
} from "./cloud-agent-activity";
import { cloudConversationApi } from "./cloud-conversation-api";
import { useCloudConversationController } from "./cloud-conversation-controller";
import {
  cloudConversationStore,
  cloudPendingPrompts,
  setCloudConversationAppActive,
  type CloudConversationState,
} from "./cloud-conversation-store";
import {
  activeCloudTurnId,
  projectCloudConversationMessages,
} from "./cloud-journal-projection";
import {
  closeDesktopBridgeSendBatch,
  negotiateDesktopBridgeCloudChat,
  fetchDesktopBridgeThreadTasks,
  sendDesktopBridgeChat,
} from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";
import { notifySuccess } from "./haptics";
import type { ChatThread, DesktopSyncOutcome } from "./use-chat-thread";

const IDLE_STATE: CloudConversationState = {
  conversationId: "",
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  records: [],
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
};

const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_STATE;
const EMPTY_MAP = new Map<string, ChatArtifact[]>();
const EMPTY_SYNC: DesktopSyncOutcome = { offline: false, rows: 0 };

export type CloudChatExecution =
  | { kind: "cloud" }
  | { kind: "desktop"; access: StoredPhoneAccess };

const friendlyError = (error: unknown): string => {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  const nested = (data as { message?: unknown } | null)?.message;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  if (error instanceof Error && error.message.trim()) return error.message;
  return "That didn't send. Try again.";
};

const clientMessageId = () => `mobile:${Crypto.randomUUID()}`;

/**
 * Canonical mobile chat hook. The only history it renders is the in-memory
 * projection of the conversation DO journal; old AsyncStorage/SQLite rows are
 * intentionally neither loaded nor changed.
 */
export function useCloudChatThread(
  execution: CloudChatExecution = { kind: "cloud" },
): ChatThread {
  const controller = useCloudConversationController();
  const conversationId = controller.conversation?.conversationId ?? null;
  const config = useQuery(
    cloudConversationApi.getCloudRealtimeConfig,
    conversationId ? {} : "skip",
  );
  const startCloudChat = useMutation(cloudConversationApi.startCloudChat);
  const cloudAgentThreadQueryArgs = resolveCloudAgentThreadQueryArgs({
    canUseOwnerData: controller.canUseOwnerData,
    conversationId,
  });
  const canShowAgentActivity = cloudAgentThreadQueryArgs !== "skip";
  const cloudAgentThreads = useQuery(
    cloudConversationApi.listMyAgentThreads,
    cloudAgentThreadQueryArgs,
  );
  const store = useMemo(
    () =>
      conversationId
        ? cloudConversationStore(controller.accountScope, conversationId)
        : null,
    [controller.accountScope, conversationId],
  );
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [desktopTaskSnapshot, setDesktopTaskSnapshot] =
    useState<ScopedCloudOperationalTasks | null>(null);

  useEffect(() => {
    const active =
      AppState.currentState === "active" ||
      AppState.currentState === "unknown";
    setCloudConversationAppActive(active);
    const subscription = AppState.addEventListener("change", (next) => {
      setCloudConversationAppActive(next === "active" || next === "unknown");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (
      execution.kind !== "desktop" ||
      !canShowAgentActivity ||
      !conversationId
    ) {
      setDesktopTaskSnapshot(null);
      return;
    }
    const capturedScope: CloudOperationalTaskScope = {
      accountScope: controller.accountScope,
      conversationId,
      desktopDeviceId: execution.access.desktopDeviceId,
    };
    let cancelled = false;
    const refresh = async () => {
      let batch: Awaited<
        ReturnType<typeof negotiateDesktopBridgeCloudChat>
      > | null = null;
      try {
        batch = await negotiateDesktopBridgeCloudChat({
          access: execution.access,
          conversationId,
        });
        const tasks = await fetchDesktopBridgeThreadTasks(
          execution.access,
          conversationId,
        );
        if (!cancelled) {
          setDesktopTaskSnapshot({
            ...capturedScope,
            tasks: tasks ?? [],
          });
        }
      } catch {
        // Operational activity is optional; canonical Convex rows remain.
        if (!cancelled) {
          setDesktopTaskSnapshot({
            ...capturedScope,
            tasks: [],
          });
        }
      } finally {
        if (batch) closeDesktopBridgeSendBatch(batch);
      }
    };
    void refresh();
    const interval = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    canShowAgentActivity,
    controller.accountScope,
    conversationId,
    execution,
  ]);

  const configResolved = config !== undefined;
  const socketOrigin =
    config?.protocol === 1 && typeof config.socketOrigin === "string"
      ? config.socketOrigin
      : null;
  useEffect(() => {
    store?.setConfig(socketOrigin, configResolved);
  }, [configResolved, socketOrigin, store]);

  const state = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );
  const allPending = useSyncExternalStore(
    cloudPendingPrompts.subscribe,
    cloudPendingPrompts.getSnapshot,
    cloudPendingPrompts.getServerSnapshot,
  );
  const pending = useMemo(
    () =>
      conversationId
        ? allPending.filter(
            (entry) =>
              entry.conversationId === conversationId &&
              entry.accountScope === controller.accountScope,
          )
        : [],
    [allPending, controller.accountScope, conversationId],
  );
  const messages = useMemo(
    () =>
      projectCloudConversationMessages({
        conversationId: conversationId ?? undefined,
        records: state.records,
        pending,
        live: state.live,
        hasOlder: state.hasOlder,
      }),
    [conversationId, pending, state.hasOlder, state.live, state.records],
  );
  const runningTurnId =
    activeCloudTurnId(state.records, state.live) ??
    [...pending].reverse().find((entry) => entry.turnId)?.turnId ??
    null;
  const sending =
    Boolean(runningTurnId) || pending.some((entry) => entry.error === null);

  const dispatch = useCallback(
    async (id: string, prompt: string): Promise<void> => {
      try {
        if (execution.kind === "desktop") {
          const batch = await negotiateDesktopBridgeCloudChat({
            access: execution.access,
            conversationId: conversationId!,
          });
          try {
            await sendDesktopBridgeChat({
              access: execution.access,
              batch,
              storageMode: "cloud",
              message: prompt,
              clientRequestId: id,
              userMessageEventId: id,
            });
          } finally {
            closeDesktopBridgeSendBatch(batch);
          }
        } else {
          const result = await startCloudChat({
            prompt,
            conversationId: conversationId!,
            clientMsgId: id,
          });
          const cancelRequested = cloudPendingPrompts.bind(
            controller.accountScope,
            id,
            result.turnId,
          );
          if (cancelRequested) store?.cancelTurn(result.turnId);
        }
        notifySuccess();
      } catch (error) {
        cloudPendingPrompts.fail(
          controller.accountScope,
          id,
          friendlyError(error),
        );
      }
    },
    [
      controller.accountScope,
      conversationId,
      execution,
      startCloudChat,
      store,
    ],
  );

  const send = useCallback((): { userMessageId: string } | null => {
    if (
      !conversationId ||
      !configResolved ||
      controller.isMigrationPending ||
      controller.migrationError ||
      controller.createError ||
      state.status === "blocked"
    ) {
      return null;
    }
    const prompt = draft.trim();
    if (!prompt && attachments.length === 0) return null;
    if (!hasAiConsent()) {
      requestAiConsent();
      return null;
    }
    const id = clientMessageId();
    cloudPendingPrompts.add(
      controller.accountScope,
      id,
      prompt || "Photo",
      conversationId,
    );
    setDraft("");

    if (attachments.length) {
      setAttachments([]);
      cloudPendingPrompts.fail(
        controller.accountScope,
        id,
        "Photo upload is not available in cloud conversations on this build yet.",
      );
      return { userMessageId: id };
    }

    void dispatch(id, prompt);
    return { userMessageId: id };
  }, [
    attachments.length,
    configResolved,
    conversationId,
    controller.createError,
    controller.accountScope,
    controller.isMigrationPending,
    controller.migrationError,
    dispatch,
    draft,
    state.status,
  ]);

  const retrySend = useCallback(
    (id: string) => {
      const entry = allPending.find(
        (candidate) =>
          candidate.accountScope === controller.accountScope &&
          candidate.clientMsgId === id &&
          candidate.conversationId === conversationId,
      );
      if (!entry) return;
      cloudPendingPrompts.clearError(controller.accountScope, id);
      void dispatch(id, entry.text);
    },
    [allPending, controller.accountScope, conversationId, dispatch],
  );

  const stop = useCallback(() => {
    if (!conversationId) return;
    const pendingCancel = cloudPendingPrompts.requestCancel(
      controller.accountScope,
      conversationId,
    );
    const turnId =
      activeCloudTurnId(state.records, state.live) ?? pendingCancel?.turnId;
    if (turnId) store?.cancelTurn(turnId);
  }, [
    controller.accountScope,
    conversationId,
    state.live,
    state.records,
    store,
  ]);

  const workingIndicator = useMemo(
    () =>
      buildWorkingIndicatorState({
        sending,
        activity: state.live
          ? {
              ...(state.live.toolName
                ? { toolName: state.live.toolName }
                : {}),
              ...(state.live.toolCallId
                ? { toolCallId: state.live.toolCallId }
                : {}),
              ...(state.live.toolLabel
                ? { statusText: state.live.toolLabel }
                : {}),
              isStreamingText: Boolean(state.live.text),
              hasToolActivity: state.live.hasToolActivity,
            }
          : IDLE_WORKING_ACTIVITY,
      }),
    [sending, state.live],
  );
  const conversationArtifacts = useMemo(
    () =>
      messages
        .flatMap((message) => message.artifacts ?? [])
        .reverse(),
    [messages],
  );
  const conversationTasks = useMemo(
    () => {
      if (!canShowAgentActivity) return [];
      const currentScope: CloudOperationalTaskScope | null =
        execution.kind === "desktop" && conversationId
          ? {
              accountScope: controller.accountScope,
              conversationId,
              desktopDeviceId: execution.access.desktopDeviceId,
            }
          : null;
      return mergeCanonicalCloudTasks(
        projectCloudAgentThreads(cloudAgentThreads),
        selectScopedCloudOperationalTasks(
          desktopTaskSnapshot,
          currentScope,
        ),
      );
    },
    [
      canShowAgentActivity,
      cloudAgentThreads,
      controller.accountScope,
      conversationId,
      desktopTaskSnapshot,
      execution,
    ],
  );
  const startupIssue = useMemo<ChatThread["startupIssue"]>(() => {
    if (controller.isMigrationPending) {
      return {
        message:
          "Moving your conversations to this account. This can take a moment.",
      };
    }
    if (controller.migrationError) {
      return {
        message: controller.migrationError,
        actionLabel: "Retry transfer",
        onAction: controller.retryMigration,
      };
    }
    if (controller.createError) {
      return {
        message: controller.createError,
        actionLabel: "Try again",
        onAction: controller.retryCreate,
      };
    }
    if (state.status === "blocked" && state.statusMessage) {
      return {
        message: state.statusMessage,
        ...(state.statusRetryable
          ? { actionLabel: "Reconnect", onAction: () => store?.retry() }
          : {}),
      };
    }
    if (
      state.status === "offline" &&
      state.records.length === 0 &&
      state.statusMessage
    ) {
      return {
        message: state.statusMessage,
        actionLabel: "Reconnect",
        onAction: () => store?.retry(),
      };
    }
    return null;
  }, [
    controller.createError,
    controller.isMigrationPending,
    controller.migrationError,
    controller.retryCreate,
    controller.retryMigration,
    state.status,
    state.statusMessage,
    state.statusRetryable,
    state.records.length,
    store,
  ]);
  const storageLoaded =
    Boolean(startupIssue) ||
    (Boolean(conversationId) &&
      configResolved &&
      (state.status === "live" ||
        state.status === "blocked" ||
        state.records.length > 0));
  const runDesktopSync = useCallback(
    async (): Promise<DesktopSyncOutcome> => {
      store?.wake();
      return EMPTY_SYNC;
    },
    [store],
  );
  const loadOlder = useCallback(() => store?.loadOlder(), [store]);

  return {
    messages,
    draft,
    setDraft,
    attachments,
    setAttachments,
    sending,
    workingIndicator,
    storageLoaded,
    conversationArtifacts,
    conversationTasks,
    activityArtifactsByTaskId: EMPTY_MAP,
    conversationOwnedArtifacts: conversationArtifacts,
    send,
    stop,
    runDesktopSync,
    // This flag is specifically the desktop operational push lane, not the
    // conversation DO socket. Task/file activity currently uses bounded pulls.
    livePushConnected: false,
    catchingUp: state.status === "connecting" && state.records.length > 0,
    hasOlder: state.hasOlder,
    loadingOlder: state.loadingOlder,
    olderNotice: state.olderNotice,
    loadOlder,
    startupIssue,
    retrySend,
  };
}
