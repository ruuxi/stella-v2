import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useIsFocused } from "expo-router";
import { authClient } from "../../src/lib/auth-client";
import {
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
  setPreferredDesktopDeviceId,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  AUTOMATIC_EXECUTION_TARGET,
  getMobileExecutionTarget,
  setMobileExecutionTarget,
} from "../../src/lib/execution-target";
import type { AutomaticExecutionTarget } from "../../src/lib/execution-placement";
import { updateStellaWidget } from "../../src/lib/home-widget";
import { tapLight, notifySuccess } from "../../src/lib/haptics";
import {
  consumePendingShare,
  subscribePendingShare,
} from "../../src/lib/pending-share";
import { type ChatThread } from "../../src/lib/use-chat-thread";
import {
  useCloudCanonicalChatThread,
  useCloudConversationAuthority,
} from "../../src/lib/use-cloud-canonical-chat-thread";
import { shouldRunDesktopForegroundTimer } from "../../src/lib/desktop-sync-policy";
import {
  setComposerModelPinned,
  useComposerModelPinned,
} from "../../src/lib/composer-model-pin";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import { useCloudModelSettings } from "../../src/lib/use-cloud-model-settings";
import { usesCloudModelSettings } from "../../src/lib/cloud-model-selection";
import {
  REASONING_OPTIONS,
  type ReasoningEffort,
} from "../../src/lib/desktop-model-prefs";
import { type DesktopConnection } from "../../src/lib/top-bar-status";
import { attachmentsSettled } from "../../src/lib/chat-attachments";
import { useIsOffline } from "../../src/lib/use-network-status";
import {
  publishActivityHub,
  publishComputerControl,
  requestOpenSidebar,
} from "../../src/lib/main-shell-store";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { ChatPane } from "../../src/components/ChatPane";
import { ConversationSwitcher } from "../../src/components/ConversationSwitcher";
import { mainContentStyles } from "../../src/components/MainScreenSurface";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { CloudBrowserInterventionCard } from "../../src/components/CloudBrowserInterventionCard";
import { ComposerNotice } from "../../src/components/ComposerNotice";
import { CloudBoundary } from "../../src/components/CloudBoundary";
import { ComputerDeviceSheet } from "../../src/components/ComputerDeviceSheet";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";
import type { ChatArtifact } from "../../src/types";
import { useT } from "../../src/i18n";

const STATUS_POLL_MS = 20_000;
/**
 * Slow verification cadence while the activity push socket is connected — the
 * live socket itself proves the computer is reachable, so the Convex status
 * poll only needs to keep the platform label fresh.
 */
const STATUS_POLL_LIVE_MS = 120_000;
/** Faster cadence while a wake request is in flight. */
const WAKE_POLL_MS = 3_000;
const WAKE_WINDOW_MS = 30_000;

type DeviceStatus = {
  checking: boolean;
  available: boolean | null;
  platform: string | null;
};

/**
 * The one chat. Its transcript belongs to the current connected or anonymous
 * session, and each turn's execution placement is decided server-side: the
 * paired computer is offered first and cloud takes the turn when no computer
 * is reachable. Pairing
 * therefore only changes what Stella can reach, never where the conversation
 * lives, so the surface is the same with or without a computer.
 */
export default function ChatScreen() {
  return <SignedInChatScreen />;
}

function SignedInChatScreen() {
  const authority = useCloudConversationAuthority();
  return (
    <View style={mainContentStyles.content}>
      {authority.status !== "ready" ? (
        <CloudAuthorityGate
          loading={authority.status === "loading"}
          issue={authority.issue?.message ?? null}
          retry={
            authority.status === "failed" && authority.issue.retryable
              ? authority.retry
              : null
          }
        />
      ) : (
        <ConversationSwitcher
          key={`${authority.authority.accountScope}:${authority.authority.ownerGeneration}`}
          authority={authority.authority}
        >
          {(selectedAuthority) => <SignedInCanonicalChat
            key={selectedAuthority.conversationId}
            authority={selectedAuthority}
            reloadAuthority={authority.retry}
          />}
        </ConversationSwitcher>
      )}
    </View>
  );
}

function SignedInCanonicalChat(props: {
  authority: NonNullable<
    ReturnType<typeof useCloudConversationAuthority>["authority"]
  >;
  reloadAuthority: () => void;
}) {
  // Pairing is resolved alongside the conversation rather than gating it: the
  // chat is usable before (and without) a paired computer.
  const [access, setAccess] = useState<StoredPhoneAccess | null>(null);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const [executionTarget, setExecutionTarget] =
    useState<AutomaticExecutionTarget>(AUTOMATIC_EXECUTION_TARGET);
  const [pairingResolved, setPairingResolved] = useState(false);
  useEffect(() => {
    void Promise.all([
      getPreferredPhoneAccess(),
      listStoredPairedPhoneAccess(),
      getMobileExecutionTarget(),
    ]).then(([stored, paired, target]) => {
      setAccess(stored);
      setPairedDesktops(paired);
      const targetStillPaired =
        target.mode !== "device" ||
        paired.some((entry) => entry.desktopDeviceId === target.deviceId);
      setExecutionTarget(
        targetStillPaired ? target : AUTOMATIC_EXECUTION_TARGET,
      );
      if (!targetStillPaired) {
        void setMobileExecutionTarget(AUTOMATIC_EXECUTION_TARGET);
      }
      setPairingResolved(true);
      if (!stored) updateStellaWidget({ paired: false, online: false });
    });
  }, []);

  const cloudModelsActive = usesCloudModelSettings(executionTarget, Boolean(access));
  const cloudModelSettings = useCloudModelSettings(cloudModelsActive);
  const thread = useCloudCanonicalChatThread(props.authority, {
    reloadAuthority: props.reloadAuthority,
    access,
    executionTarget,
    ...(cloudModelsActive && cloudModelSettings.execution
      ? { execution: cloudModelSettings.execution }
      : {}),
  });

  const updateAccess = useCallback((next: StoredPhoneAccess) => {
    setAccess(next);
    setPairedDesktops((current) => [
      next,
      ...current.filter(
        (entry) => entry.desktopDeviceId !== next.desktopDeviceId,
      ),
    ]);
  }, []);

  const updateExecutionTarget = useCallback(
    (next: AutomaticExecutionTarget) => {
      setExecutionTarget(next);
      void setMobileExecutionTarget(next);
      if (next.mode === "device") {
        const selected = pairedDesktops.find(
          (entry) => entry.desktopDeviceId === next.deviceId,
        );
        if (selected) {
          setAccess(selected);
          void setPreferredDesktopDeviceId(selected.desktopDeviceId);
        }
      }
    },
    [pairedDesktops],
  );

  return (
    <ChatSurface
      thread={thread}
      cloudModelSettings={cloudModelSettings}
      access={access}
      pairedDesktops={pairedDesktops}
      executionTarget={executionTarget}
      pairingResolved={pairingResolved}
      onAccessChange={updateAccess}
      onExecutionTargetChange={updateExecutionTarget}
    />
  );
}

function CloudAuthorityGate(props: {
  loading: boolean;
  issue: string | null;
  retry: (() => void) | null;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.centerSurface}>
      {props.loading ? (
        <ActivityIndicator color={colors.textMuted} />
      ) : (
        <>
          <Text style={styles.gateMessage}>{props.issue}</Text>
          {props.retry ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.retry}
              style={styles.retry}
            >
              <Text style={styles.retryText}>
                {t("mobile.common.tryAgain")}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function ChatSurface(props: {
  thread: ChatThread;
  cloudModelSettings: ReturnType<typeof useCloudModelSettings>;
  access: StoredPhoneAccess | null;
  pairedDesktops: StoredPhoneAccess[];
  executionTarget: AutomaticExecutionTarget;
  pairingResolved: boolean;
  onAccessChange: (access: StoredPhoneAccess) => void;
  onExecutionTargetChange: (target: AutomaticExecutionTarget) => void;
}) {
  const {
    thread,
    cloudModelSettings,
    access,
    pairedDesktops,
    executionTarget,
    pairingResolved,
    onAccessChange,
    onExecutionTargetChange,
  } = props;
  const colors = useColors();
  const t = useT();
  const session = authClient.useSession();
  const anonymous = session.data?.user?.isAnonymous === true;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const offline = useIsOffline();
  const isFocused = useIsFocused();
  const composerModelPinned = useComposerModelPinned();
  const cloudModelsActive = usesCloudModelSettings(executionTarget, Boolean(access));
  const modelSettings = useComputerModelSettings(cloudModelsActive ? null : access);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [deviceSheetOpen, setDeviceSheetOpen] = useState(false);
  const [appActive, setAppActive] = useState(
    () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const [status, setStatus] = useState<DeviceStatus>({
    checking: true,
    available: null,
    platform: null,
  });
  const [waking, setWaking] = useState(false);
  const wakeUntilRef = useRef(0);
  const { setDraft, addAttachments } = thread;

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active" || next === "unknown");
    });
    return () => sub.remove();
  }, []);

  // Content shared in from another app prefills the composer (it never
  // auto-sends — the user confirms with the send button).
  useEffect(() => {
    const applyShare = () => {
      const share = consumePendingShare();
      if (!share) return;
      if (share.text) {
        setDraft((previous: string) =>
          previous.trim()
            ? `${previous.trimEnd()} ${share.text}`
            : (share.text ?? ""),
        );
      }
      if (share.attachments?.length) addAttachments(share.attachments);
    };
    applyShare();
    return subscribePendingShare(applyShare);
  }, [addAttachments, setDraft]);

  const checkStatus = useCallback(async (desktopDeviceId: string) => {
    try {
      const next = await getDesktopBridgeStatus(desktopDeviceId);
      setStatus({
        checking: false,
        available: next.available,
        platform: next.platform,
      });
      updateStellaWidget({
        paired: true,
        online: next.available,
        ...(next.platform ? { platform: next.platform } : {}),
      });
      return next.available;
    } catch {
      setStatus((prev) => ({ ...prev, checking: false, available: false }));
      return false;
    }
  }, []);

  // An attached push socket is authoritative: reflect "connected" immediately
  // instead of waiting out the current poll interval.
  const livePushConnected = thread.livePushConnected;
  const livePushConnectedRef = useRef(livePushConnected);
  useEffect(() => {
    livePushConnectedRef.current = livePushConnected;
    if (!livePushConnected) return;
    setStatus((prev) => {
      updateStellaWidget({
        paired: true,
        online: true,
        ...(prev.platform ? { platform: prev.platform } : {}),
      });
      return { ...prev, checking: false, available: true };
    });
    setWaking(false);
  }, [livePushConnected]);

  useEffect(() => {
    if (!access) {
      setStatus({ checking: false, available: null, platform: null });
      return;
    }
    if (!shouldRunDesktopForegroundTimer({ focused: isFocused, appActive })) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      // While push is live the socket is the liveness signal; skip the Convex
      // round-trip (and never let a stale lease read downgrade the badge).
      if (livePushConnectedRef.current) {
        timer = setTimeout(() => void tick(), STATUS_POLL_LIVE_MS);
        return;
      }
      const available = await checkStatus(access.desktopDeviceId);
      if (cancelled) return;
      const wakePending = !available && Date.now() < wakeUntilRef.current;
      if (available || !wakePending) setWaking(false);
      timer = setTimeout(
        () => void tick(),
        wakePending ? WAKE_POLL_MS : STATUS_POLL_MS,
      );
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [access, appActive, checkStatus, isFocused]);

  useEffect(() => {
    if (status.available === true && waking) {
      notifySuccess();
      setWaking(false);
    }
  }, [status.available, waking]);

  const triggerWake = useCallback(() => {
    if (!access) return;
    setWaking(true);
    wakeUntilRef.current = Date.now() + WAKE_WINDOW_MS;
    void requestDesktopConnection(access).catch(() => setWaking(false));
  }, [access]);

  const wake = useCallback(() => {
    tapLight();
    triggerWake();
  }, [triggerWake]);

  // Auto-wake: a turn placed on a sleeping computer falls back to cloud, so
  // landing here and finding the computer asleep should start a wake attempt on
  // its own rather than quietly giving up the computer for the whole session.
  // Fire once per asleep spell — re-armed only after it next comes online — so
  // a computer that stays off isn't spammed; the device sheet's Wake button
  // remains for an explicit retry.
  const autoWokeRef = useRef(false);
  useEffect(() => {
    if (!isFocused || status.available === true) {
      autoWokeRef.current = false;
      return;
    }
    if (
      access &&
      !offline &&
      status.available === false &&
      !waking &&
      !autoWokeRef.current
    ) {
      autoWokeRef.current = true;
      triggerWake();
    }
  }, [access, isFocused, offline, status.available, triggerWake, waking]);

  const connection: DesktopConnection =
    status.checking || waking
      ? "connecting"
      : status.available
        ? "connected"
        : "disconnected";

  // The top bar's computer button is chrome owned by the layout above this
  // route, so its state and tap handler travel through the shell store.
  const openComputer = useCallback(() => {
    if (access) setDeviceSheetOpen(true);
    else if (pairingResolved) setPairSheetOpen(true);
  }, [access, pairingResolved]);
  const computerLabel = !access
    ? t("mobile.computer.pairLabel")
    : connection === "connecting"
      ? t("mobile.computer.connectingLabel")
      : connection === "connected"
        ? t("mobile.computer.connectedLabel")
        : t("mobile.computer.disconnectedLabel");
  useEffect(() => {
    if (!access && !pairingResolved) {
      publishComputerControl(null);
      return;
    }
    publishComputerControl({
      connection: access ? connection : null,
      label: computerLabel,
      onPress: openComputer,
    });
  }, [access, pairingResolved, connection, computerLabel, openComputer]);

  // The sidebar shows this conversation's background work, so it reads the
  // same rows the retired activity sheet did, published as they change.
  const {
    conversationTasks,
    conversationArtifacts,
    activityArtifactsByTaskId,
    conversationOwnedArtifacts,
  } = thread;
  useEffect(() => {
    publishActivityHub({
      tasks: conversationTasks,
      artifacts: conversationArtifacts,
      artifactsByTaskId: activityArtifactsByTaskId,
      conversationArtifacts: conversationOwnedArtifacts,
      access,
    });
  }, [
    conversationTasks,
    conversationArtifacts,
    activityArtifactsByTaskId,
    conversationOwnedArtifacts,
    access,
  ]);
  // Leaving the chat (sign-out, authority swap) clears what the chrome shows.
  useEffect(
    () => () => {
      publishActivityHub(null);
      publishComputerControl(null);
    },
    [],
  );

  const platformLabel =
    status.platform?.trim() || t("mobile.computer.defaultDeviceLabel");
  const statusLabel = status.checking
    ? t("mobile.computer.statusChecking")
    : waking
      ? t("mobile.computer.statusWaking")
      : status.available
        ? t("mobile.computer.statusConnected")
        : t("mobile.computer.statusAsleep");

  const canSubmit =
    (thread.draft.trim().length > 0 ||
      thread.attachments.length > 0 ||
      thread.quotes.length > 0) &&
    // A turn is only sendable once every attachment has a drive path. Until
    // then the chip is still uploading or has failed, and sending would drop it.
    attachmentsSettled(thread.attachments) &&
    !(cloudModelsActive && cloudModelSettings.saving) &&
    !offline &&
    thread.storageLoaded &&
    thread.authorityReady !== false;
  const sendRealtimePrompt = thread.sendPrompt;
  const performRealtimeVoiceAction = useCallback(
    async (request: string) => sendRealtimePrompt?.(request) ?? null,
    [sendRealtimePrompt],
  );

  const composerModelPicker = useMemo(() => {
    if (cloudModelsActive) {
      return {
        pinned: true,
        label: cloudModelSettings.label,
        loading: cloudModelSettings.loading && !cloudModelSettings.execution,
        saving: cloudModelSettings.saving,
        effortLabel: cloudModelSettings.effort === "default"
          ? t("settings.agentModelPicker.default")
          : t(`settings.reasoningEffort.${cloudModelSettings.effort}`),
        effortOptions: REASONING_OPTIONS.map((option) => ({
          ...option,
          label: option.id === "default"
            ? t("settings.agentModelPicker.default")
            : t(`settings.reasoningEffort.${option.id}`),
          selected: option.id === cloudModelSettings.effort,
        })),
        recentModels: cloudModelSettings.models,
        onOpen: () => { void cloudModelSettings.refresh(); },
        onSelectEffort: (id: string) => cloudModelSettings.selectEffort(id as ReasoningEffort),
        onSelectModel: cloudModelSettings.selectModel,
      };
    }
    if (!access) return undefined;
    return {
      // The pinned composer picker is a developer-mode surface; an explicit
      // "off" from the paired computer unpins it regardless of local state.
      pinned:
        composerModelPinned && modelSettings.developerModeEnabled !== false,
      label: modelSettings.selectedModelLabel,
      loading: modelSettings.loading && !modelSettings.snapshot,
      saving: modelSettings.saving,
      effortLabel:
        REASONING_OPTIONS.find(
          (option) => option.id === modelSettings.selectedEffort,
        )?.label ?? "Auto",
      effortOptions: REASONING_OPTIONS.map((option) => ({
        ...option,
        selected: option.id === modelSettings.selectedEffort,
      })),
      recentModels: modelSettings.recentModels,
      onOpen: () => {
        void modelSettings.refresh().catch(() => undefined);
      },
      onSelectEffort: (id: string) =>
        modelSettings.selectEffort(id as ReasoningEffort),
      onSelectModel: modelSettings.selectRecentModel,
    };
  }, [access, cloudModelsActive, cloudModelSettings, composerModelPinned, modelSettings, t]);

  return (
    <View style={styles.screen}>
      {thread.authorityIssue ? (
        <View style={styles.authorityIssue}>
          <Text style={styles.authorityIssueText}>
            {thread.authorityIssue.message}
          </Text>
          {thread.authorityIssue.retryable ? (
            <Pressable
              accessibilityRole="button"
              onPress={thread.authorityIssue.retry}
              style={styles.authorityRetry}
            >
              <Text style={styles.authorityRetryText}>
                {t("mobile.common.tryAgain")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ChatPane
        messages={thread.messages}
        streaming={thread.sending}
        workingIndicator={thread.workingIndicator}
        emptyContent={
          <Text style={styles.emptyText}>{t("mobile.chat.emptyPrompt")}</Text>
        }
        historyLoading={!thread.storageLoaded}
        hasOlderHistory={thread.hasOlderMessages}
        hasNewerHistory={thread.hasNewerMessages}
        historyPageLoading={thread.historyPageLoading}
        onLoadOlderHistory={thread.loadOlderMessages}
        onLoadNewerHistory={thread.loadNewerMessages}
        draft={thread.draft}
        onChangeDraft={thread.setDraft}
        {...(composerModelPicker ? { composerModelPicker } : {})}
        canSubmit={canSubmit}
        onSubmit={thread.send}
        onStop={thread.stop}
        realtimeVoiceConversationId={thread.conversationId}
        realtimeVoiceExecution={access ? "computer" : "phone"}
        {...(access ? { realtimeVoiceDesktopAccess: access } : {})}
        onRealtimeVoiceAction={performRealtimeVoiceAction}
        placeholder={t("mobile.chat.composerPlaceholder")}
        composerIntervention={
          <>
            <CloudBoundary resetKey={thread.conversationId}>
              <CloudBrowserInterventionCard
                conversationId={thread.conversationId}
              />
            </CloudBoundary>
            <ComposerNotice conversationId={thread.conversationId} />
          </>
        }
        offline={offline}
        enableAttachments
        attachments={thread.attachments}
        onAddAttachments={thread.addAttachments}
        onRemoveAttachment={thread.removeAttachment}
        onRetryAttachment={thread.retryAttachment}
        quotes={thread.quotes}
        onAddQuote={thread.addQuote}
        onRemoveQuote={thread.removeQuote}
        maxAttachments={thread.maxAttachments}
        dictationAnonymous={anonymous}
        onOpenArtifact={setSelectedArtifact}
        conversationId={thread.conversationId}
        activityTasks={thread.conversationTasks}
        onOpenActivity={requestOpenSidebar}
        catchingUp={thread.catchingUp}
      />
      <PairPhoneSheet
        visible={pairSheetOpen}
        onClose={() => setPairSheetOpen(false)}
        onPaired={(paired) => {
          onAccessChange(paired);
          setPairSheetOpen(false);
        }}
        preferredAccess={access}
        pairedDesktops={pairedDesktops}
        onSwitchDesktop={onAccessChange}
      />
      {access ? (
        <ComputerDeviceSheet
          visible={deviceSheetOpen}
          onClose={() => setDeviceSheetOpen(false)}
          access={access}
          platformLabel={platformLabel}
          statusLabel={statusLabel}
          statusAvailable={status.available}
          connecting={status.checking || waking}
          showWake={!status.checking && !status.available && !waking}
          onWake={wake}
          onRepaired={onAccessChange}
          pairedDesktops={pairedDesktops}
          executionTarget={executionTarget}
          onExecutionTargetChange={onExecutionTargetChange}
          modelSettings={modelSettings}
          composerModelPinned={composerModelPinned}
          onComposerModelPinnedChange={setComposerModelPinned}
        />
      ) : null}
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={access}
        onClose={() => setSelectedArtifact(null)}
      />
    </View>
  );
}

const makeStyles = (colors: {
  border: string;
  surface: string;
  text: string;
  textMuted: string;
}) =>
  StyleSheet.create({
    screen: { flex: 1 },
    centerSurface: {
      alignItems: "center",
      flex: 1,
      gap: 14,
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    emptyText: {
      color: colors.textMuted,
      fontFamily: fonts.display.regularItalic,
      fontSize: 22,
      letterSpacing: -0.5,
      opacity: 0.45,
      textAlign: "center",
    },
    gateMessage: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    retry: {
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    retryText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
    },
    authorityIssue: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      justifyContent: "center",
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    authorityIssueText: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
    },
    authorityRetry: {
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    authorityRetryText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
    },
  } as const);
