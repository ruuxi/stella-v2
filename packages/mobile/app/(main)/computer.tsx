import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import {
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { updateStellaWidget } from "../../src/lib/home-widget";
import { tapLight, notifySuccess, notifyError } from "../../src/lib/haptics";
import { useChatThread } from "../../src/lib/use-chat-thread";
import { shouldRunDesktopForegroundTimer } from "../../src/lib/desktop-sync-policy";
import { useIsOffline } from "../../src/lib/use-network-status";
import {
  setComposerModelPinned,
  useComposerModelPinned,
} from "../../src/lib/composer-model-pin";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import {
  REASONING_OPTIONS,
  type ReasoningEffort,
} from "../../src/lib/desktop-model-prefs";
import { type DesktopConnection } from "../../src/lib/top-bar-status";
import { useColors } from "../../src/theme/theme-context";
import { type Colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import type { ChatArtifact } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";
import { ActivityHubSheet } from "../../src/components/ActivityHubSheet";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { ComputerDeviceSheet } from "../../src/components/ComputerDeviceSheet";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { useT } from "../../src/i18n";

const STATUS_POLL_MS = 20_000;

const STATUS_POLL_LIVE_MS = 120_000;

const WAKE_POLL_MS = 3_000;
const WAKE_WINDOW_MS = 30_000;

const RESUME_DEBOUNCE_MS = 1_500;

type DeviceStatus = {
  checking: boolean;
  available: boolean | null;
  platform: string | null;
};

export default function ComputerScreen() {
  if (isGuest()) {
    return <GuestComputerSurface />;
  }
  return <ComputerRouter />;
}

function GuestComputerSurface() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.centerSurface}>
      <View style={styles.heroBlock}>
        <ConnectHeroAnimation />
        <Text style={styles.heroTitle}>
          {t("mobile.computer.guestHeroTitle")}
        </Text>
        <Text style={styles.heroBody}>
          {t("mobile.computer.guestHeroBody")}
        </Text>
      </View>
      <View style={styles.signInSection}>
        <SignInPrompt />
      </View>
    </View>
  );
}

function ComputerRouter() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [phoneAccess, setPhoneAccess] = useState<StoredPhoneAccess | null>(
    null,
  );
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
      if (!access) {
        updateStellaWidget({ paired: false, online: false });
      }
    });
  }, []);

  if (paired === null) {
    return <View style={styles.centerSurface} />;
  }

  if (paired === false || !phoneAccess) {
    return (
      <View style={styles.centerSurface}>
        <View style={styles.heroBlock}>
          <ConnectHeroAnimation />
          <Text style={styles.heroTitle}>
            {t("mobile.computer.pairFirstTitle")}
          </Text>
          <Text style={styles.heroBody}>
            {t("mobile.computer.pairFirstBody")}
          </Text>
          <PrimaryButton
            label={t("mobile.computer.pairPhone")}
            onPress={() => setPairSheetOpen(true)}
            accessibilityLabel={t("mobile.computer.pairThisPhoneLabel")}
            style={styles.primaryButton}
          />
        </View>
        <PairPhoneSheet
          visible={pairSheetOpen}
          onClose={() => setPairSheetOpen(false)}
          onPaired={(access) => {
            setPhoneAccess(access);
            setPaired(true);
            setPairSheetOpen(false);
          }}
        />
      </View>
    );
  }

  return (
    <ComputerChatSurface access={phoneAccess} onAccessChange={setPhoneAccess} />
  );
}

function ComputerChatSurface({
  access,
  onAccessChange,
}: {
  access: StoredPhoneAccess;
  onAccessChange: (access: StoredPhoneAccess) => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const offline = useIsOffline();
  const composerModelPinned = useComposerModelPinned();
  const modelSettings = useComputerModelSettings(access);

  const transport = useMemo(
    () => ({ kind: "desktop" as const, access }),
    [access],
  );
  const thread = useChatThread({ threadId: "computer", transport });
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(
    () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );

  const [deviceSheetOpen, setDeviceSheetOpen] = useState(false);
  const [activityHubOpen, setActivityHubOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const [status, setStatus] = useState<DeviceStatus>({
    checking: true,
    available: null,
    platform: null,
  });
  const [waking, setWaking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const wakeUntilRef = useRef(0);

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

  const livePushConnected = thread.livePushConnected;
  const livePushConnectedRef = useRef(livePushConnected);
  useEffect(() => {
    livePushConnectedRef.current = livePushConnected;

    if (livePushConnected) {
      setStatus((prev) => {
        updateStellaWidget({
          paired: true,
          online: true,
          ...(prev.platform ? { platform: prev.platform } : {}),
        });
        return { ...prev, checking: false, available: true };
      });
      setWaking(false);
    }
  }, [livePushConnected]);

  useEffect(() => {
    if (!shouldRunDesktopForegroundTimer({ focused: isFocused, appActive })) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {

      if (livePushConnectedRef.current) {
        timer = setTimeout(() => void tick(), STATUS_POLL_LIVE_MS);
        return;
      }
      const available = await checkStatus(access.desktopDeviceId);
      if (cancelled) return;
      const wakePending = !available && Date.now() < wakeUntilRef.current;
      if (available || !wakePending) {
        setWaking(false);
      }
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
  }, [appActive, checkStatus, access.desktopDeviceId, isFocused]);

  const connection: DesktopConnection =
    status.checking || waking
      ? "connecting"
      : status.available
        ? "connected"
        : "disconnected";

  useEffect(() => {
    if (status.available === true && waking) {
      notifySuccess();
      setWaking(false);
    }
  }, [status.available, waking]);

  const triggerWake = useCallback(() => {
    setWaking(true);
    wakeUntilRef.current = Date.now() + WAKE_WINDOW_MS;
    void requestDesktopConnection(access).catch(() => setWaking(false));
  }, [access]);

  const wake = useCallback(() => {
    tapLight();
    triggerWake();
  }, [triggerWake]);

  const autoWokeRef = useRef(false);
  useEffect(() => {

    if (!isFocused || status.available === true) {
      autoWokeRef.current = false;
      return;
    }
    if (
      !offline &&
      status.available === false &&
      !waking &&
      !autoWokeRef.current
    ) {
      autoWokeRef.current = true;
      triggerWake();
    }
  }, [isFocused, offline, status.available, waking, triggerWake]);

  const runDesktopSync = thread.runDesktopSync;
  const offlineRef = useRef(offline);
  const wakingRef = useRef(waking);
  const isFocusedRef = useRef(isFocused);
  useEffect(() => {
    offlineRef.current = offline;
    wakingRef.current = waking;
    isFocusedRef.current = isFocused;
  }, [offline, waking, isFocused]);

  const lastResumeRef = useRef(0);
  const skipNextAvailabilityCatchUpRef = useRef(false);
  const reconnectOrSync = useCallback(async () => {

    if (!isFocusedRef.current) return;

    const now = Date.now();
    if (now - lastResumeRef.current < RESUME_DEBOUNCE_MS) return;
    lastResumeRef.current = now;

    const outcome = await runDesktopSync({ catchUp: true, trigger: "resume" });
    if (!outcome.offline && !outcome.error) {
      skipNextAvailabilityCatchUpRef.current = status.available === false;
      setStatus((previous) => ({
        ...previous,
        checking: false,
        available: true,
      }));
      updateStellaWidget({
        paired: true,
        online: true,
        ...(status.platform ? { platform: status.platform } : {}),
      });
      setWaking(false);
      return;
    }
    setStatus((previous) => ({
      ...previous,
      checking: false,
      available: false,
    }));
    if (!offlineRef.current && !wakingRef.current && !autoWokeRef.current) {
      autoWokeRef.current = true;
      triggerWake();
    }
  }, [runDesktopSync, status.available, status.platform, triggerWake]);

  const wasAvailableRef = useRef<boolean | null>(null);
  useEffect(() => {
    const was = wasAvailableRef.current;
    wasAvailableRef.current = status.available;
    if (status.available === true && was === false) {
      if (skipNextAvailabilityCatchUpRef.current) {
        skipNextAvailabilityCatchUpRef.current = false;
        return;
      }
      void runDesktopSync({ catchUp: true, trigger: "reconnect" });
    }
  }, [status.available, runDesktopSync]);

  const reconnectOrSyncRef = useRef(reconnectOrSync);
  useEffect(() => {
    reconnectOrSyncRef.current = reconnectOrSync;
  }, [reconnectOrSync]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const active = next === "active" || next === "unknown";
      setAppActive(active);
      if (active) void reconnectOrSyncRef.current();
    });
    return () => sub.remove();
  }, []);

  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (isFocused && !wasFocused) void reconnectOrSync();
  }, [isFocused, reconnectOrSync]);

  const forceSync = useCallback(async () => {
    if (syncing) return;
    tapLight();
    setSyncing(true);
    try {
      const available = await checkStatus(access.desktopDeviceId);
      if (!available) {
        if (!offlineRef.current && !wakingRef.current) triggerWake();
        notifyError();
        Alert.alert(
          t("mobile.computer.unreachableTitle"),
          t("mobile.computer.unreachableBody"),
        );
        return;
      }
      const outcome = await runDesktopSync({
        catchUp: true,
        trigger: "force-sync",
      });
      if (outcome.deferred) {
        notifyError();
        Alert.alert(
          t("mobile.computer.syncWaitingTitle"),
          t("mobile.computer.syncWaitingBody"),
        );
        return;
      }
      if (outcome.offline || outcome.error) {
        notifyError();
        Alert.alert(
          t("mobile.computer.syncFailedTitle"),
          outcome.error ?? t("mobile.computer.syncFailedBody"),
        );
        return;
      }
      notifySuccess();
    } catch (error) {
      notifyError();
      Alert.alert(
        t("mobile.computer.syncFailedTitle"),
        error instanceof Error
          ? error.message
          : t("mobile.common.somethingWentWrong"),
      );
    } finally {
      setSyncing(false);
    }
  }, [
    syncing,
    checkStatus,
    access.desktopDeviceId,
    triggerWake,
    runDesktopSync,
    t,
  ]);

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
    !offline &&
    thread.storageLoaded;

  const composerModelPicker = useMemo(
    () => ({

      pinned: composerModelPinned && modelSettings.developerModeEnabled !== false,
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
    }),
    [composerModelPinned, modelSettings],
  );

  return (
    <View style={styles.screen}>
      <ChatPane
        messages={thread.messages}
        streaming={thread.sending}
        workingIndicator={thread.workingIndicator}
        emptyContent={
          <Text style={styles.emptyText}>
            {t("mobile.computer.emptyPrompt")}
          </Text>
        }
        historyLoading={!thread.storageLoaded}
        draft={thread.draft}
        onChangeDraft={thread.setDraft}
        composerModelPicker={composerModelPicker}
        canSubmit={canSubmit}
        onSubmit={thread.send}
        onStop={thread.stop}
        realtimeVoiceConversationId={thread.conversationId}
        realtimeVoiceExecution="computer"
        realtimeVoiceDesktopAccess={access}
        placeholder={t("mobile.computer.composerPlaceholder")}
        offline={offline}
        enableAttachments
        attachments={thread.attachments}
        onChangeAttachments={thread.setAttachments}
        quotes={thread.quotes}
        onAddQuote={thread.addQuote}
        onRemoveQuote={thread.removeQuote}
        dictationAnonymous={false}
        onOpenArtifact={setSelectedArtifact}
        conversationId={thread.conversationId}
        onOpenDeviceSheet={() => setDeviceSheetOpen(true)}
        computerConnection={connection}
        computerConnectionLabel={
          connection === "connecting"
            ? t("mobile.computer.connectingLabel")
            : connection === "connected"
              ? t("mobile.computer.connectedLabel")
              : t("mobile.computer.disconnectedLabel")
        }
        activityTasks={thread.conversationTasks}
        onOpenActivityHub={() => setActivityHubOpen(true)}
        catchingUp={thread.catchingUp}
      />
      <ActivityHubSheet
        visible={activityHubOpen}
        onClose={() => setActivityHubOpen(false)}
        tasks={thread.conversationTasks}
        artifacts={thread.conversationArtifacts}
        artifactsByTaskId={thread.activityArtifactsByTaskId}
        conversationArtifacts={thread.conversationOwnedArtifacts}
        access={access}
      />
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
        onForceSync={forceSync}
        syncing={syncing}
        onRepaired={onAccessChange}
        modelSettings={modelSettings}
        composerModelPinned={composerModelPinned}
        onComposerModelPinnedChange={setComposerModelPinned}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    emptyText: {
      color: colors.textMuted,
      fontFamily: fonts.display.regularItalic,
      fontSize: 22,
      letterSpacing: -0.5,
      opacity: 0.45,
      textAlign: "center",
    },
    centerSurface: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    heroBlock: {
      alignItems: "center",
      gap: 8,
    },
    heroTitle: {
      color: colors.textMuted,
      fontFamily: fonts.display.regularItalic,
      fontSize: 22,
      letterSpacing: -0.5,
      opacity: 0.7,
      textAlign: "center",
    },
    heroBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 22,
      marginTop: 8,
      maxWidth: 280,
      textAlign: "center",
    },
    signInSection: {
      alignItems: "center",
      marginTop: 28,
    },
    primaryButton: {
      marginTop: 16,
    },
  } as const);
