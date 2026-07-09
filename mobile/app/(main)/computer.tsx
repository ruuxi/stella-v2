import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  StyleSheet,
  Text,
  View,
} from "react-native";
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
  useTopBarStatus,
  type DesktopConnection,
} from "../../src/lib/top-bar-status";
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

const STATUS_POLL_MS = 20_000;
/**
 * Slow verification cadence while the localChat push socket is connected —
 * the live socket itself proves the desktop is reachable, so the Convex
 * status poll only needs to keep the platform label fresh.
 */
const STATUS_POLL_LIVE_MS = 120_000;
/** Faster cadence while a wake request is in flight. */
const WAKE_POLL_MS = 3_000;
const WAKE_WINDOW_MS = 30_000;
/**
 * Collapses a focus + AppState "active" pair firing on the same return into a
 * single connect-or-sync action so we don't double-fire the resume handler.
 */
const RESUME_DEBOUNCE_MS = 1_500;

type DeviceStatus = {
  checking: boolean;
  available: boolean | null;
  platform: string | null;
};

/**
 * The Computer tab hosts the conversation with the paired desktop's Stella
 * agent. Its device controls (status, wake, view-screen, artifacts, model
 * settings) live in a sheet opened from the composer's gear button.
 */
export default function ComputerScreen() {
  if (isGuest()) {
    return <GuestComputerSurface />;
  }
  return <ComputerRouter />;
}

function GuestComputerSurface() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.centerSurface}>
      <View style={styles.heroBlock}>
        <ConnectHeroAnimation />
        <Text style={styles.heroTitle}>Your computer, at your fingertips</Text>
        <Text style={styles.heroBody}>
          Ask Stella to do things on your computer — browse the web, manage
          files, run tasks, and more.
        </Text>
      </View>
      <View style={styles.signInSection}>
        <SignInPrompt />
      </View>
    </View>
  );
}

/**
 * Loads the pairing state and routes to the right surface. Each branch is its
 * own component so the chat surface can call its hooks unconditionally once a
 * valid access is known.
 */
function ComputerRouter() {
  const colors = useColors();
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
          <Text style={styles.heroTitle}>Pair your phone first</Text>
          <Text style={styles.heroBody}>
            Pair this phone with your Stella desktop so you can chat with it
            from anywhere. You only need to do it once.
          </Text>
          <PrimaryButton
            label="Pair phone"
            onPress={() => setPairSheetOpen(true)}
            accessibilityLabel="Pair this phone"
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
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const offline = useIsOffline();
  const { setConnection: setTopBarConnection } = useTopBarStatus();

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

  // Poll bridge availability while the surface is mounted; tighten the cadence
  // while a wake request is pending, and relax it while the localChat push
  // socket is live (an open socket already proves the desktop is reachable).
  const livePushConnected = thread.livePushConnected;
  const livePushConnectedRef = useRef(livePushConnected);
  useEffect(() => {
    livePushConnectedRef.current = livePushConnected;
    // A freshly connected push socket is authoritative: reflect "connected"
    // immediately instead of waiting out the current poll interval.
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
      // While push is live the socket is the liveness signal; skip the Convex
      // round-trip (and never let a stale lease read downgrade the badge).
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
    setTopBarConnection(connection);
  }, [connection, setTopBarConnection]);
  useEffect(() => () => setTopBarConnection(null), [setTopBarConnection]);

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

  // Auto-wake: the computer tab exists to talk to the desktop, so landing here
  // and finding it asleep should start a wake attempt on its own rather than
  // making the user open the device sheet and tap Wake. Fire once per asleep
  // spell — armed again only after it next comes online — so a desktop that
  // stays off isn't spammed with wake requests; the sheet's manual Wake button
  // remains for an explicit retry. Gated on focus and a settled offline read so
  // we don't wake a computer the user isn't even looking at, or when the phone
  // has no connectivity to deliver the request.
  const autoWokeRef = useRef(false);
  useEffect(() => {
    // Re-arm whenever the user leaves the tab or the desktop comes online, so a
    // later return (or a fresh sleep) gets one more automatic attempt.
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

  // Returning to this surface "later" — either by foregrounding the app
  // (AppState → active) or navigating back onto the computer tab (focus
  // transition) — must self-heal the connection. The transport is
  // request/response, not a live socket: while the app is backgrounded the
  // ~20s status poll is throttled, so a connection that dropped meanwhile is
  // never re-attempted, and a tab that stayed focused across a
  // background/foreground cycle fires no focus transition for the existing
  // auto-wake effect to catch. On return we re-check status immediately, then:
  // if the desktop is asleep, re-run the SAME wake handshake; if it is up, run
  // a catch-up `runDesktopSync()` so a phone that went stale in the background
  // pulls any desktop turns it missed.
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
    // Only act when this paired-desktop surface is the one the user is on, so
    // we never wake a computer the user isn't looking at.
    if (!isFocusedRef.current) return;
    // Debounce so a focus + AppState pair on the same return acts once.
    const now = Date.now();
    if (now - lastResumeRef.current < RESUME_DEBOUNCE_MS) return;
    lastResumeRef.current = now;
    // The bridge sync is authoritative and already performs bounded wake /
    // rediscovery. Starting it directly avoids a serialized backend status
    // lookup before every foreground catch-up.
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

  // Reconnection invariant: whenever the desktop transitions from unavailable
  // to available while this surface is mounted — wake handshake landing,
  // tunnel coming back, push socket reattaching — run a catch-up pull. This is
  // what actually syncs after the resume handler's wake branch (which can't
  // pull anything itself: the desktop wasn't reachable yet), and it also
  // covers connectivity gaps that never went through the resume handler.
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

  // Mirror into a ref so the once-mounted AppState subscription always invokes
  // the latest closure without re-subscribing.
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

  // Fire on the focus false → true transition (navigating back onto the tab).
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (isFocused && !wasFocused) void reconnectOrSync();
  }, [isFocused, reconnectOrSync]);

  // Manual "Force Sync" from the device sheet. Runs a catch-up (full-window)
  // pull — never the delta cursor, so a cursor that got ahead of undelivered
  // rows can't turn this into a silent no-op — and reports honestly: fresh
  // rows, or a visible error explaining why nothing came in. `runDesktopSync`
  // coalesces in-flight runs and the `syncing` guard blocks double-taps, so
  // this never stacks work.
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
          "Computer unreachable",
          "Your computer isn't reachable right now. A wake request was sent — try again in a few seconds.",
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
          "Sync waiting",
          "A message is still being sent. The sync will run as soon as it finishes.",
        );
        return;
      }
      if (outcome.offline || outcome.error) {
        notifyError();
        Alert.alert(
          "Sync failed",
          outcome.error ??
            "Your computer stopped responding while syncing. Try again.",
        );
        return;
      }
      notifySuccess();
    } catch (error) {
      notifyError();
      Alert.alert(
        "Sync failed",
        error instanceof Error ? error.message : "Something went wrong.",
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
  ]);

  const platformLabel = status.platform?.trim() || "Your computer";
  const statusLabel = status.checking
    ? "Checking…"
    : waking
      ? "Waking up…"
      : status.available
        ? "Connected"
        : "Asleep";

  const canSubmit =
    (thread.draft.trim().length > 0 || thread.attachments.length > 0) &&
    !offline &&
    thread.storageLoaded;

  return (
    <View style={styles.screen}>
      <ChatPane
        messages={thread.messages}
        streaming={thread.sending}
        workingIndicator={thread.workingIndicator}
        emptyContent={
          <Text style={styles.emptyText}>Ask your computer anything</Text>
        }
        historyLoading={!thread.storageLoaded}
        draft={thread.draft}
        onChangeDraft={thread.setDraft}
        canSubmit={canSubmit}
        onSubmit={thread.send}
        onStop={thread.stop}
        placeholder="Message your computer"
        offline={offline}
        enableAttachments
        attachments={thread.attachments}
        onChangeAttachments={thread.setAttachments}
        dictationAnonymous={false}
        onOpenArtifact={setSelectedArtifact}
        onOpenDeviceSheet={() => setDeviceSheetOpen(true)}
        activityTasks={thread.conversationTasks}
        onOpenActivityHub={() => setActivityHubOpen(true)}
        catchingUp={thread.catchingUp}
      />
      <ActivityHubSheet
        visible={activityHubOpen}
        onClose={() => setActivityHubOpen(false)}
        tasks={thread.conversationTasks}
        artifacts={thread.conversationArtifacts}
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
