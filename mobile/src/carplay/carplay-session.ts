/**
 * Stella's CarPlay surface controller.
 *
 * CarPlay only lets us drive Apple's templates (we can't render arbitrary RN
 * views on the head unit), so this is an imperative state machine over the
 * `react-native-carplay` bridge rather than a React tree.
 *
 * v2 owns exactly ONE surface: a `CPListTemplate` voice home. v1 also
 * presented a `CPVoiceControlTemplate` overlay while listening and pushed a
 * `CPNowPlayingTemplate` replay card while speaking — but every template
 * transition proved to be another way for a real head unit to strand the
 * driver on a surface without a working tap (the build-91 dead-tap bug).
 * All state now renders into the list rows via `updateSections`, which never
 * changes the template stack. Row content is built by the pure helpers in
 * {@link ./carplay-home} so it stays unit-testable.
 *
 * The actual chat send + dictation + text-to-speech all live in the existing
 * mobile plumbing; {@link CarPlayBridge} hooks those up and drives the phases
 * here. This module never imports `react-native-carplay` at module scope (its
 * singleton instantiates a NativeEventEmitter on construction, which throws on
 * platforms without the native module) — it lazy-`require`s it on iOS only.
 */

import { Image, Platform, Settings, type ImageSourcePropType } from "react-native";
import {
  buildHome,
  flattenActions,
  parseTemplateConfig,
  type CarPlayHomeState,
  type CarPlayPhase,
  type HomeRow,
  type HomeRowAction,
  type RecentReply,
} from "./carplay-home";

export type { CarPlayPhase } from "./carplay-home";

const DIAGNOSTICS_KEY = "StellaCarPlayDiagnostics";
/**
 * NSUserDefaults flag mirroring the CarPlay connection state. Persisted so
 * the NEXT launch (including a crash-relaunch with the car still attached)
 * can synchronously know a head unit is probably connected before the JS
 * session has received didConnect — see carplay-appearance-policy.ts.
 */
const CONNECTED_FLAG_KEY = "StellaCarPlayConnected";

/** Sync best-effort read of the persisted CarPlay-connected flag. */
export function readPersistedCarPlayConnected(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    const value = Settings.get(CONNECTED_FLAG_KEY) as unknown;
    return value === true || value === 1;
  } catch {
    return false;
  }
}

/**
 * JS-side CarPlay breadcrumb: logs to the JS console AND appends to the same
 * `StellaCarPlayDiagnostics` user-defaults array the native scene delegate and
 * the patched RNCarPlay module write to (via the `Settings` bridge to
 * NSUserDefaults). On a real head unit — where the Metro console doesn't exist
 * — this makes the JS takeover steps visible right next to the native
 * breadcrumbs when diagnosing from Console.app or a diagnostics dump.
 */
export function carPlayLog(message: string) {
  console.info(`[carplay] ${message}`);
  if (Platform.OS !== "ios") return;
  try {
    const existing = Settings.get(DIAGNOSTICS_KEY) as unknown;
    const lines = Array.isArray(existing) ? (existing as string[]) : [];
    const next = [...lines, `${new Date().toISOString()} [js] ${message}`];
    while (next.length > 80) next.shift();
    Settings.set({ [DIAGNOSTICS_KEY]: next });
  } catch {
    // Diagnostics must never break the CarPlay flow.
  }
}

/**
 * Delays for asserting the JS root template after a connect. There is
 * deliberately NO immediate attempt: the first call is held back past the
 * native placeholder's own (async) setRootTemplate completion.
 *
 * Why (the build-97 "phone app already open" crash): the native scene
 * delegate installs its placeholder root and forwards the connect to
 * RNCarPlay in the same tick. JS's `setRootTemplate` is the ONLY thing that
 * installs `interfaceController.delegate = RNCarPlay` (RNCarPlay.m). On a
 * cold start JS is slow, so the placeholder appears while the delegate is
 * still nil and its appear events go nowhere — safe. But when the CarPlay
 * scene attaches to an ALREADY-RUNNING app, JS answers the connect within
 * milliseconds: it sets the delegate and its root BEFORE the placeholder's
 * async setRootTemplate completes, so the placeholder appears ON TOP with a
 * live delegate. RNCarPlay's `templateWillAppear` then reads
 * `userInfo[@"templateId"]` from the placeholder — which has none — and
 * `[NSMutableDictionary setObject:nil]` throws an uncaught
 * NSInvalidArgumentException → SIGABRT (reproduced in the CarPlay simulator;
 * crash stack: sendTemplateEventWithName ← templateWillAppear).
 *
 * Deferring our first setRootTemplate past the placeholder's appear window
 * restores the (proven-safe) cold-start ordering in the warm case too, and
 * as a bonus stops the placeholder's late completion from stomping the JS
 * root. Pure JS, so it rides an OTA; the root-cause native fix (give the
 * placeholder a templateId + nil-guard in RNCarPlay) needs build 98.
 */
const SET_ROOT_RETRY_DELAYS_MS = [1500, 3500, 8000];
/** Poll cadence/cap for nudging native `checkForConnection` until connected. */
const CONNECT_POLL_INTERVAL_MS = 2000;
const CONNECT_POLL_MAX_ATTEMPTS = 15;
/** How often the relative timestamps re-render while connected. */
const TIME_REFRESH_INTERVAL_MS = 30_000;

/** Callbacks the bridge binds so CarPlay taps drive the real voice loop. */
export type CarPlayActions = {
  /** The tap-to-talk row was selected (toggles record → stop + send). */
  onTalk: () => void;
  /** A recent-reply row was selected — read THAT message aloud. */
  onReadReply: (id: string) => void;
  /** The dedicated read-latest row was selected — read the newest reply. */
  onReadLatest: () => void;
  /** The converse-mode row was selected — flip auto-read on/off. */
  onToggleConverse: () => void;
  /** The voice-target row was selected — switch phone chat ↔ computer chat. */
  onToggleVoiceTarget: () => void;
};

// Stella-green glyphs (see assets/carplay/generate-icons.py). Carrying the
// brand's success/ok green into the few tintable template slots is the closest
// CarPlay lets us get to Stella's visual language.
const MIC_ICON = require("../../assets/carplay/stella-voice-mic.png") as ImageSourcePropType;
const LISTENING_ICON = require("../../assets/carplay/stella-voice-listening.png") as ImageSourcePropType;
const REPLAY_ICON = require("../../assets/carplay/stella-voice-replay.png") as ImageSourcePropType;

type RNCarPlay = typeof import("react-native-carplay");

class CarPlaySession {
  private rnc: RNCarPlay | null = null;
  private CarPlay: RNCarPlay["CarPlay"] | null = null;

  private actions: CarPlayActions | null = null;
  private phase: CarPlayPhase = "idle";
  private speakingPreview = "";
  private replies: RecentReply[] = [];
  private newReplyId: string | null = null;
  private converseOn = true;
  /** Where dictated messages route; mirrored from the bridge's resolution. */
  private voiceTarget: "phone" | "computer" = "phone";
  /** Whether a computer is paired (renders the target row at all). */
  private voiceTargetSelectable = false;
  private timeRefreshTimer: ReturnType<typeof setInterval> | null = null;

  private listTemplate: InstanceType<RNCarPlay["ListTemplate"]> | null = null;
  /** Flat tap-index → action map matching the last rendered sections. */
  private rowActions: HomeRowAction[] = [];

  private registered = false;
  private connected = false;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private setRootRetryTimers: ReturnType<typeof setTimeout>[] = [];
  private connectPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Bind (or rebind) the live action closures from the React bridge. */
  bindActions(actions: CarPlayActions) {
    this.actions = actions;
  }

  /** Lazily load react-native-carplay on iOS; no-op elsewhere. */
  private load(): boolean {
    if (Platform.OS !== "ios") return false;
    if (this.rnc) return true;
    try {
      // Breadcrumb the native-module presence BEFORE requiring the library:
      // react-native-carplay's CarPlay singleton constructs a
      // NativeEventEmitter(RNCarPlay) at module scope, which throws when the
      // interop layer didn't surface the module — and that throw used to be
      // invisible on-device (console.warn only).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NativeModules } = require("react-native") as {
        NativeModules: Record<string, unknown>;
      };
      carPlayLog(
        `NativeModules.RNCarPlay ${NativeModules.RNCarPlay ? "present" : "MISSING"}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("react-native-carplay") as RNCarPlay;
      this.rnc = mod;
      this.CarPlay = mod.CarPlay;
      carPlayLog("react-native-carplay module loaded");
      this.installParseConfigShim(mod);
      return true;
    } catch (error) {
      carPlayLog(`react-native-carplay require FAILED: ${String(error)}`);
      return false;
    }
  }

  /**
   * Root-cause fix for the build-93 on-car crash
   * (`[js] JS connect handler FAILED: TypeError: Object is not a function`):
   * react-native-carplay's `Template.parseConfig` calls a broken
   * `require('react-native/Libraries/Image/resolveAssetSource')` binding —
   * on RN 0.83 that returns the ESM namespace object, not the function — so
   * every template constructor/updateSections with an `image` throws.
   * Replace the method on the shared base prototype with
   * {@link parseTemplateConfig} driven by the public `Image.resolveAssetSource`.
   * Done here (our JS) rather than in the bun patch so the fix rides
   * expo-updates OTA: the fingerprint hashes the `patches/` dir, and touching
   * the patch would force a new binary.
   */
  private installParseConfigShim(mod: RNCarPlay) {
    try {
      // The shim only exists to route around the library's broken
      // resolveAssetSource require; if the public API we depend on isn't the
      // expected shape in THIS bundle (minified release interop can differ
      // from dev), leave the library untouched rather than install a shim
      // that would throw later.
      const resolveAssetSource = (
        Image as unknown as {
          resolveAssetSource?: (source: unknown) => unknown;
        }
      ).resolveAssetSource;
      if (typeof resolveAssetSource !== "function") {
        carPlayLog(
          "parseConfig shim SKIPPED: Image.resolveAssetSource unavailable",
        );
        return;
      }
      const listProto = (mod.ListTemplate as unknown as { prototype: object })
        .prototype;
      // parseConfig lives on the base Template prototype; patch it there so
      // every template subclass gets the fix.
      const base = Object.getPrototypeOf(listProto) as {
        parseConfig?: (config: unknown) => unknown;
      } | null;
      const target =
        base && typeof base.parseConfig === "function"
          ? base
          : (listProto as { parseConfig?: (config: unknown) => unknown });
      const original = target.parseConfig;
      target.parseConfig = function (
        this: unknown,
        config: unknown,
      ): unknown {
        try {
          return parseTemplateConfig(config, (source) =>
            resolveAssetSource(source),
          );
        } catch (error) {
          // The shim must never be a new way to crash a template: fall back
          // to the upstream implementation (broken only for image keys) and
          // leave a breadcrumb naming the failure.
          carPlayLog(`parseConfig shim threw, using upstream: ${String(error)}`);
          if (typeof original === "function") {
            return original.call(this, config);
          }
          throw error;
        }
      };
      carPlayLog("installed parseConfig interop shim");
    } catch (error) {
      carPlayLog(`parseConfig shim FAILED: ${String(error)}`);
    }
  }

  /** Register connect/disconnect handlers exactly once (called on iOS mount). */
  register() {
    if (this.registered) return;
    carPlayLog("session.register() called");
    if (!this.load() || !this.CarPlay) {
      carPlayLog("session.register() bailed — CarPlay bridge unavailable");
      return;
    }
    this.registered = true;

    const handleConnect = () => {
      // This whole callback runs when a head unit hands us its interface
      // controller (and again on forced retries from the native watchdog /
      // placeholder tap). Any throw in here is an exception inside a
      // native-event listener — unguarded it surfaces as an unhandled JS error
      // on connect and can take the phone app down mid-drive. Keep the entire
      // connect path fail-safe: on error the native placeholder remains
      // visible (and now tappable) rather than leaving the head unit dead.
      try {
        carPlayLog(
          `JS connect handler running (alreadyConnected=${this.connected})`,
        );
        const firstConnect = !this.connected;
        this.connected = true;
        this.publishConnectionState(true);
        this.stopConnectPoll();
        this.buildTemplates();
        carPlayLog("JS templates built");
        if (firstConnect) {
          this.phase = "idle";
        }
        this.setRootWithRetries();
        carPlayLog("rendering home rows");
        this.render();
        this.startTimeRefresh();
        carPlayLog(`JS connect handler finished (phase=${this.phase})`);
      } catch (error) {
        carPlayLog(`JS connect handler FAILED: ${String(error)}`);
      }
    };

    this.CarPlay.registerOnConnect(handleConnect);
    carPlayLog("JS registered onConnect callback");

    // react-native-carplay checks RNCPStore for an existing connection inside
    // its module constructor. If the car connected before this singleton was
    // registered, that replay fires while `onConnectCallbacks` is still empty:
    // `CarPlay.connected` becomes true, but Stella never gets a chance to set
    // the root template. Replay the already-connected state after registering
    // our callback, and ask native to re-check in case its first replay
    // arrived between construction and this registration.
    if (this.CarPlay.connected) {
      carPlayLog("replaying already-connected CarPlay session");
      handleConnect();
    } else {
      // Ask native to replay a connection our listener may have missed, and
      // keep nudging on an interval: on a real head unit the first didConnect
      // can be emitted before this module registered its listener (the event
      // is dropped with zero listeners), and a single checkForConnection can
      // still race module setup. The poll stops as soon as we're connected.
      carPlayLog("not connected yet — starting checkForConnection poll");
      this.CarPlay.bridge?.checkForConnection?.();
      this.startConnectPoll();
    }

    this.CarPlay.registerOnDisconnect(() => {
      carPlayLog("JS disconnect handler running");
      this.connected = false;
      this.publishConnectionState(false);
      this.clearSetRootRetries();
      this.stopTimeRefresh();
      this.startConnectPoll();
    });
  }

  /**
   * Subscribe to CarPlay connection changes (used by the appearance guard to
   * re-apply a deferred color scheme after the car disconnects). Returns an
   * unsubscribe function.
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private publishConnectionState(connected: boolean) {
    try {
      Settings.set({ [CONNECTED_FLAG_KEY]: connected ? 1 : 0 });
    } catch {
      // The persisted flag is best-effort.
    }
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch (error) {
        carPlayLog(`connection listener FAILED: ${String(error)}`);
      }
    }
  }

  /**
   * Assert the JS root template on a delayed schedule (never immediately —
   * see SET_ROOT_RETRY_DELAYS_MS for why the first attempt MUST trail the
   * native placeholder's appear window; an immediate call crashes the whole
   * app when the CarPlay scene attaches to an already-running phone app).
   * Re-asserting is idempotent and cheap — on the head unit that failed in
   * the field, a single silently-failed `setRootTemplate` left a dead UI —
   * and every attempt is logged for on-unit triage.
   */
  private setRootWithRetries() {
    this.clearSetRootRetries();
    const attempt = (label: string) => {
      if (!this.connected || !this.CarPlay || !this.listTemplate) return;
      try {
        carPlayLog(`setRootTemplate attempt (${label})`);
        this.CarPlay.setRootTemplate(this.listTemplate, false);
      } catch (error) {
        carPlayLog(`setRootTemplate (${label}) FAILED: ${String(error)}`);
      }
    };
    this.setRootRetryTimers = SET_ROOT_RETRY_DELAYS_MS.map((delay) =>
      setTimeout(() => attempt(`deferred+${delay}ms`), delay),
    );
  }

  private clearSetRootRetries() {
    for (const timer of this.setRootRetryTimers) clearTimeout(timer);
    this.setRootRetryTimers = [];
  }

  private startConnectPoll() {
    if (this.connectPollTimer) return;
    let attempts = 0;
    this.connectPollTimer = setInterval(() => {
      if (this.connected || attempts >= CONNECT_POLL_MAX_ATTEMPTS) {
        this.stopConnectPoll();
        return;
      }
      attempts += 1;
      carPlayLog(`checkForConnection poll attempt ${attempts}`);
      try {
        this.CarPlay?.bridge?.checkForConnection?.();
      } catch (error) {
        carPlayLog(`checkForConnection poll FAILED: ${String(error)}`);
      }
    }, CONNECT_POLL_INTERVAL_MS);
  }

  private stopConnectPoll() {
    if (!this.connectPollTimer) return;
    clearInterval(this.connectPollTimer);
    this.connectPollTimer = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private buildTemplates() {
    if (!this.rnc) return;
    // Build once per app lifetime: every Template construction registers
    // NativeEventEmitter listeners keyed by the (fixed) template id and never
    // removes them, so rebuilding on each connect/retry would stack duplicate
    // listeners and double-fire onItemSelect. The native side keeps templates
    // by id in RNCPStore, so reusing the JS instances across reconnects is
    // safe — setRootTemplate just re-references the same id.
    if (this.listTemplate) return;
    const { ListTemplate } = this.rnc;

    carPlayLog("building home rows");
    const home = this.currentHome();
    this.rowActions = flattenActions(home);
    carPlayLog("constructing ListTemplate (createTemplate -> native)");
    this.listTemplate = new ListTemplate({
      id: "stella-voice-home",
      title: "Stella",
      sections: home.map((section) => ({
        header: section.header,
        items: section.rows.map((row) => this.decorateRow(row)),
      })),
      onItemSelect: async ({ index }) => {
        this.onRowSelected(index);
      },
    });
    carPlayLog("ListTemplate constructed");
  }

  private currentState(): CarPlayHomeState {
    return {
      phase: this.phase,
      speakingPreview: this.speakingPreview,
      replies: this.replies,
      newReplyId: this.newReplyId,
      converseOn: this.converseOn,
      target: this.voiceTarget,
      targetSelectable: this.voiceTargetSelectable,
      now: Date.now(),
    };
  }

  private currentHome() {
    return buildHome(this.currentState());
  }

  /** Attach the brand icons the pure builders deliberately know nothing about. */
  private decorateRow(row: HomeRow) {
    let image: ImageSourcePropType | undefined;
    if (row.action.kind === "talk") {
      image = this.phase === "listening" ? LISTENING_ICON : MIC_ICON;
    } else if (row.action.kind === "readLatest") {
      image = REPLAY_ICON;
    }
    return { ...row.item, image };
  }

  /** Resolve a flat tap index against the last rendered rows and dispatch. */
  private onRowSelected(index: number) {
    const action = this.rowActions[index];
    carPlayLog(
      `row selected index=${index} action=${action ? action.kind : "unknown"} phase=${this.phase}`,
    );
    if (!action) return;
    switch (action.kind) {
      case "talk":
        this.actions?.onTalk();
        break;
      case "readReply":
        this.actions?.onReadReply(action.id);
        break;
      case "readLatest":
        this.actions?.onReadLatest();
        break;
      case "toggleConverse":
        this.actions?.onToggleConverse();
        break;
      case "toggleTarget":
        this.actions?.onToggleVoiceTarget();
        break;
    }
  }

  /**
   * Latest assistant replies (newest first); re-renders the reply rows. When
   * the newest reply's id changes (and this isn't the initial hydration from
   * storage), the row is marked "New" until something reads it aloud.
   */
  setRecentReplies(replies: RecentReply[]) {
    const prevNewestId = this.replies[0]?.id ?? null;
    const nextNewestId = replies[0]?.id ?? null;
    const changed =
      replies.length !== this.replies.length ||
      replies.some(
        (reply, i) =>
          reply.id !== this.replies[i]?.id ||
          reply.text !== this.replies[i]?.text,
      );
    if (
      prevNewestId !== null &&
      nextNewestId !== null &&
      nextNewestId !== prevNewestId
    ) {
      this.newReplyId = nextNewestId;
    }
    this.replies = replies;
    if (changed) this.render();
  }

  /** Reflect the bridge-owned converse-mode state on the toggle row. */
  setConverseMode(on: boolean) {
    if (this.converseOn === on) return;
    this.converseOn = on;
    this.render();
  }

  /**
   * Converse mode survives voice-loop remounts (the bridge remounts its loop
   * when the target switches); the fresh loop re-adopts the session's state
   * instead of resetting the driver's choice.
   */
  getConverseMode(): boolean {
    return this.converseOn;
  }

  /** Reflect the resolved voice target (and pairing) on the target row. */
  setVoiceTarget(target: "phone" | "computer", selectable: boolean) {
    if (
      this.voiceTarget === target &&
      this.voiceTargetSelectable === selectable
    ) {
      return;
    }
    this.voiceTarget = target;
    this.voiceTargetSelectable = selectable;
    this.render();
  }

  /** A reply was read aloud (tap or auto-play) — clear its "New" marker. */
  markReplyRead(id: string) {
    if (this.newReplyId !== id) return;
    this.newReplyId = null;
    this.render();
  }

  private startTimeRefresh() {
    if (this.timeRefreshTimer) return;
    this.timeRefreshTimer = setInterval(() => {
      if (this.replies.length > 0) this.render();
    }, TIME_REFRESH_INTERVAL_MS);
  }

  private stopTimeRefresh() {
    if (!this.timeRefreshTimer) return;
    clearInterval(this.timeRefreshTimer);
    this.timeRefreshTimer = null;
  }

  /** Move to a new phase and reconcile the visible rows. */
  setPhase(phase: CarPlayPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.render();
  }

  getPhase(): CarPlayPhase {
    return this.phase;
  }

  /** Short preview of the reply being spoken, shown on the talk row. */
  setReplyPreview(text: string) {
    this.speakingPreview = text;
    if (this.phase === "speaking") this.render();
  }

  /** Re-render the (single) list template from current state. */
  private render() {
    if (!this.connected || !this.listTemplate) return;
    try {
      const home = this.currentHome();
      this.rowActions = flattenActions(home);
      this.listTemplate.updateSections(
        home.map((section) => ({
          header: section.header,
          items: section.rows.map((row) => this.decorateRow(row)),
        })),
      );
    } catch (error) {
      carPlayLog(`failed to update home rows: ${String(error)}`);
    }
  }
}

/** App-wide singleton; the bridge binds actions and drives phases on it. */
export const carPlaySession = new CarPlaySession();
