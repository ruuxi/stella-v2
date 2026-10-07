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
  followDesktopDeviceIdSuccession,
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
  setPreferredDesktopDeviceId,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  CLOUD_EXECUTION_TARGET,
  getMobileExecutionTarget,
  getMobileExecutionTargetSetAt,
  setMobileExecutionTarget,
} from "../../src/lib/execution-target";
import {
  listExecutionDevices,
  type AutomaticExecutionTarget,
} from "../../src/lib/execution-placement";
import { updateStellaWidget } from "../../src/lib/home-widget";
import { notifySuccess } from "../../src/lib/haptics";
import {
  consumePendingShare,
  subscribePendingShare,
} from "../../src/lib/pending-share";
import {
  clearPendingComposerDraft,
  peekPendingComposerDraft,
} from "../../src/lib/onboarding-handoff";
import { hasAiConsent } from "../../src/lib/ai-consent";
import { type ChatThread } from "../../src/lib/use-chat-thread";
import {
  useCloudCanonicalChatThread,
  useCloudConversationAuthority,
} from "../../src/lib/use-cloud-canonical-chat-thread";
import {
  setComposerModelPinned,
  useComposerModelPinned,
} from "../../src/lib/composer-model-pin";
import { useCloudModelSettings } from "../../src/lib/use-cloud-model-settings";
import { usesCloudModelSettings } from "../../src/lib/cloud-model-selection";
import { resolveRealtimeVoiceRoute } from "../../src/lib/realtime-voice-routing";
import {
  REASONING_OPTIONS,
  type ReasoningEffort,
} from "../../src/lib/stella-model-catalog";
import { attachmentsSettled } from "../../src/lib/chat-attachments";
import { useIsOffline } from "../../src/lib/use-network-status";
import {
  publishActivityHub,
  publishComputerControl,
  requestOpenSidebar,
} from "../../src/lib/main-shell-store";
import { settleStaleHubTasks } from "../../src/lib/activity-hub-model";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { ChatPane } from "../../src/components/ChatPane";
import {
  mainContentStyles,
  useShellTopInset,
} from "../../src/components/MainScreenSurface";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { CloudBrowserInterventionCard } from "../../src/components/CloudBrowserInterventionCard";
import { CloudConnectorConnectCard } from "../../src/components/CloudConnectorConnectCard";
import { UserAskCard } from "../../src/components/UserAskCard";
import { ComposerNotice } from "../../src/components/ComposerNotice";
import { CloudBoundary } from "../../src/components/CloudBoundary";
import type { ChatArtifact } from "../../src/types";
import { useT } from "../../src/i18n";

/** How often the paired computer's presence is re-read while chat is open. */
const STATUS_POLL_MS = 20_000;
/** How often a parked onboarding message retries its send, and for how long. */
/** Coarse enough to be free, fine enough that a settled task clears promptly. */
const HUB_STALE_RECHECK_MS = 30_000;
const HANDOFF_SEND_RETRY_MS = 400;
const HANDOFF_SEND_MAX_ATTEMPTS = 150;

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
    <View style={[mainContentStyles.content, chatContentStyle]}>
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
        // One conversation per account: there is no switching or new chat.
        <SignedInCanonicalChat
          key={`${authority.authority.accountScope}:${authority.authority.ownerGeneration}:${authority.authority.conversationId}`}
          authority={authority.authority}
          reloadAuthority={authority.retry}
        />
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
    useState<AutomaticExecutionTarget>(CLOUD_EXECUTION_TARGET);
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
        targetStillPaired ? target : CLOUD_EXECUTION_TARGET,
      );
      if (!targetStillPaired) {
        void setMobileExecutionTarget(CLOUD_EXECUTION_TARGET);
      }
      setPairingResolved(true);
      if (!stored) updateStellaWidget({ paired: false, online: false });
    });
  }, []);

  const cloudModelsActive = usesCloudModelSettings(executionTarget, Boolean(access));
  // One account-wide selection for cloud and computer turns alike.
  const cloudModelSettings = useCloudModelSettings(true);
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
    (next: AutomaticExecutionTarget, setAt?: number) => {
      setExecutionTarget(next);
      void setMobileExecutionTarget(next, setAt);
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

  const destinationSwitch = thread.destinationSwitch;
  useEffect(() => {
    if (!pairingResolved || !destinationSwitch) return;
    let active = true;
    void getMobileExecutionTargetSetAt().then((setAt) => {
      if (!active || destinationSwitch.at <= setAt) return;
      const destination = destinationSwitch.destination;
      if (destination.toLowerCase() === "cloud") {
        updateExecutionTarget(CLOUD_EXECUTION_TARGET, destinationSwitch.at);
      } else if (
        pairedDesktops.some((entry) => entry.desktopDeviceId === destination)
      ) {
        updateExecutionTarget(
          { mode: "device", deviceId: destination },
          destinationSwitch.at,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [destinationSwitch, pairedDesktops, pairingResolved, updateExecutionTarget]);

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
  const topInset = useShellTopInset();

  return (
    <View style={[styles.centerSurface, { paddingTop: topInset }]}>
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
  const topInset = useShellTopInset();
  const offline = useIsOffline();
  const isFocused = useIsFocused();
  const composerModelPinned = useComposerModelPinned();
  const cloudModelsActive = usesCloudModelSettings(executionTarget, Boolean(access));
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
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

  // The first message from onboarding (a starter, or what the user typed
  // there): prefill it at once, then send it as soon as the conversation can
  // take a turn. Until the AI-data consent is granted the send would only
  // re-raise the consent sheet, so it waits for that too; if it never
  // becomes sendable the text simply stays in the composer.
  const [handoffDraft] = useState(peekPendingComposerDraft);
  const sendRef = useRef(thread.send);
  sendRef.current = thread.send;
  const draftStore = thread.draftStore;
  useEffect(() => {
    if (!handoffDraft) return;
    clearPendingComposerDraft();
    setDraft(handoffDraft.text);
  }, [handoffDraft, setDraft]);

  // The computer is reachable exactly when its presence connection to the
  // cloud is live, so the owner's device list is the status source.
  const checkStatus = useCallback(async (desktopDeviceId: string) => {
    try {
      const devices = await listExecutionDevices();
      const device = devices.find((entry) => entry.deviceId === desktopDeviceId);
      if (!device) {
        // A computer that rotated its device id is listed under the new one;
        // re-file the pairing there instead of reading it as offline forever.
        const moved = await followDesktopDeviceIdSuccession(
          desktopDeviceId,
        ).catch(() => null);
        if (moved) {
          onAccessChange(moved);
          return false;
        }
      }
      const available = device?.online === true;
      const label = device?.label?.trim() || null;
      setStatus({ checking: false, available, platform: label });
      updateStellaWidget({
        paired: true,
        online: available,
        ...(label ? { platform: label } : {}),
      });
      return available;
    } catch {
      setStatus((prev) => ({ ...prev, checking: false, available: false }));
      return false;
    }
  }, [onAccessChange]);

  useEffect(() => {
    if (!access) {
      setStatus({ checking: false, available: null, platform: null });
      return;
    }
    if (!isFocused || !appActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await checkStatus(access.desktopDeviceId);
      if (cancelled) return;
      timer = setTimeout(() => void tick(), STATUS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [access, appActive, checkStatus, isFocused]);

  // Celebrate the computer coming back while the user is looking.
  const previousAvailableRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (previousAvailableRef.current === false && status.available === true) {
      notifySuccess();
    }
    previousAvailableRef.current = status.available;
  }, [status.available]);

  // The sidebar shows this conversation's background work, so it reads the
  // same rows the retired activity sheet did, published as they change.
  const {
    conversationTasks,
    conversationArtifacts,
    activityArtifactsByTaskId,
    conversationOwnedArtifacts,
  } = thread;
  // Stale `running` rows are settled on the way in (see `settleStaleHubTasks`),
  // so the chrome never reports work the fold only *believes* is still going.
  // Staleness is a function of elapsed time rather than of any state change, so
  // a task can cross the window with nothing to re-render it — hence the coarse
  // re-publish, armed only while something still claims to be running.
  const hasRunningConversationTask = conversationTasks.some(
    (task) => task.status === "running",
  );
  useEffect(() => {
    const publish = () => {
      publishActivityHub({
        tasks: settleStaleHubTasks(conversationTasks),
        artifacts: conversationArtifacts,
        artifactsByTaskId: activityArtifactsByTaskId,
        conversationArtifacts: conversationOwnedArtifacts,
        access,
      });
    };
    publish();
    if (!hasRunningConversationTask) return undefined;
    const timer = setInterval(publish, HUB_STALE_RECHECK_MS);
    return () => clearInterval(timer);
  }, [
    conversationTasks,
    conversationArtifacts,
    activityArtifactsByTaskId,
    conversationOwnedArtifacts,
    access,
    hasRunningConversationTask,
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
    : status.available
      ? t("mobile.computer.statusConnected")
      : t("mobile.computer.statusAsleep");

  // The Settings tab shows the paired computer and where turns run, but that
  // state lives here, so it travels through the shell store. The chat stays
  // mounted under every tab, so what Settings shows stays live. Built from
  // the fields Settings reads (not the whole model-settings object, which is
  // new every render) so streaming doesn't re-render Settings per token.
  const connecting = status.checking;
  const computerModel = useMemo(
    () => ({ label: cloudModelSettings.label, settings: cloudModelSettings }),
    [cloudModelSettings],
  );
  useEffect(() => {
    if (!pairingResolved) return;
    publishComputerControl({
      access,
      pairedDesktops,
      platformLabel,
      statusLabel,
      statusAvailable: status.available,
      connecting,
      onRepaired: onAccessChange,
      executionTarget,
      onExecutionTargetChange,
      model: computerModel,
      composerModelPinned,
      onComposerModelPinnedChange: setComposerModelPinned,
    });
  }, [
    pairingResolved,
    access,
    pairedDesktops,
    platformLabel,
    statusLabel,
    status.available,
    connecting,
    onAccessChange,
    executionTarget,
    onExecutionTargetChange,
    computerModel,
    composerModelPinned,
  ]);

  // Content (typed text, an attachment or a quote) is checked by the pane, so
  // this screen never reads the draft and a keystroke never re-renders it.
  const sendReady =
    // A turn is only sendable once every attachment has a drive path. Until
    // then the chip is still uploading or has failed, and sending would drop it.
    attachmentsSettled(thread.attachments) &&
    !(cloudModelsActive && cloudModelSettings.saving) &&
    !offline &&
    thread.storageLoaded &&
    thread.authorityReady !== false;
  const handoffSentRef = useRef(false);
  useEffect(() => {
    if (!handoffDraft?.send || handoffSentRef.current || !sendReady) return;
    let attempts = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const attempt = () => {
      attempts += 1;
      // The user took over the composer (edited or cleared it): leave it.
      const settled =
        draftStore.get().trim() !== handoffDraft.text ||
        attempts > HANDOFF_SEND_MAX_ATTEMPTS ||
        (hasAiConsent() && sendRef.current() !== null);
      if (!settled) return;
      handoffSentRef.current = true;
      if (timer) clearInterval(timer);
    };
    attempt();
    if (handoffSentRef.current) return;
    timer = setInterval(attempt, HANDOFF_SEND_RETRY_MS);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [draftStore, handoffDraft, sendReady]);
  const sendRealtimePrompt = thread.sendPrompt;
  const performRealtimeVoiceAction = useCallback(
    async (request: string) => sendRealtimePrompt?.(request) ?? null,
    [sendRealtimePrompt],
  );
  // Voice follows the execution selection: Cloud stays on the phone even with
  // paired computers, and a chosen computer runs voice tools on that computer.
  const realtimeVoiceRoute = useMemo(
    () =>
      resolveRealtimeVoiceRoute({
        executionTarget,
        preferredAccess: access,
        pairedDesktops,
      }),
    [access, executionTarget, pairedDesktops],
  );

  const composerModelPicker = useMemo(
    () => ({
      // One pin for both cloud and computer chats: off by default, and only
      // the user's own "Show in composer" toggle turns it on.
      pinned: composerModelPinned,
      label: cloudModelSettings.label,
      loading: cloudModelSettings.loading && !cloudModelSettings.execution,
      saving: cloudModelSettings.saving,
      effortLabel: cloudModelSettings.effort === "default"
        ? t("settings.agentModelPicker.default")
        : t(`settings.reasoningEffort.${cloudModelSettings.effort}`),
      effortOptions: cloudModelSettings.supportsEffortSelection
        ? REASONING_OPTIONS.map((option) => ({
            ...option,
            label: option.id === "default"
              ? t("settings.agentModelPicker.default")
              : t(`settings.reasoningEffort.${option.id}`),
            selected: option.id === cloudModelSettings.effort,
          }))
        : [],
      recentModels: cloudModelSettings.models,
      onOpen: () => { void cloudModelSettings.refresh(); },
      onSelectEffort: (id: string) => cloudModelSettings.selectEffort(id as ReasoningEffort),
      onSelectModel: cloudModelSettings.selectModel,
    }),
    [cloudModelSettings, composerModelPinned, t],
  );

  return (
    <View style={styles.screen}>
      {thread.authorityIssue ? (
        <View style={[styles.authorityIssue, { marginTop: topInset }]}>
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
        draftStore={thread.draftStore}
        {...(composerModelPicker ? { composerModelPicker } : {})}
        sendReady={sendReady}
        onSubmit={thread.send}
        onStop={thread.stop}
        realtimeVoiceConversationId={thread.conversationId}
        realtimeVoiceExecution={realtimeVoiceRoute.execution}
        realtimeVoiceDesktopAccess={realtimeVoiceRoute.desktopAccess}
        desktopAccess={access}
        onRealtimeVoiceAction={performRealtimeVoiceAction}
        placeholder={t("mobile.chat.composerPlaceholder")}
        composerIntervention={
          <>
            <CloudBoundary resetKey={thread.conversationId}>
              <UserAskCard conversationId={thread.conversationId} />
              <CloudConnectorConnectCard
                conversationId={thread.conversationId}
              />
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
        {...(thread.authorityIssue ? { topInset: 0 } : {})}
      />
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={access}
        onClose={() => setSelectedArtifact(null)}
      />
    </View>
  );
}

/** The transcript runs edge to edge under the floating top bar. */
const chatContentStyle = { paddingTop: 0 } as const;

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
