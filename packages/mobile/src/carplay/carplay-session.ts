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

const CONNECTED_FLAG_KEY = "StellaCarPlayConnected";

export function readPersistedCarPlayConnected(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    const value = Settings.get(CONNECTED_FLAG_KEY) as unknown;
    return value === true || value === 1;
  } catch {
    return false;
  }
}

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

  }
}

const SET_ROOT_RETRY_DELAYS_MS = [1500, 3500, 8000];

const CONNECT_POLL_INTERVAL_MS = 2000;
const CONNECT_POLL_MAX_ATTEMPTS = 15;

const TIME_REFRESH_INTERVAL_MS = 30_000;

export type CarPlayActions = {

  onTalk: () => void;

  onReadReply: (id: string) => void;

  onReadLatest: () => void;

  onToggleConverse: () => void;

  onToggleVoiceTarget: () => void;
};

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

  private voiceTarget: "phone" | "computer" = "phone";

  private voiceTargetSelectable = false;
  private timeRefreshTimer: ReturnType<typeof setInterval> | null = null;

  private listTemplate: InstanceType<RNCarPlay["ListTemplate"]> | null = null;

  private rowActions: HomeRowAction[] = [];

  private registered = false;
  private connected = false;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private setRootRetryTimers: ReturnType<typeof setTimeout>[] = [];
  private connectPollTimer: ReturnType<typeof setInterval> | null = null;

  bindActions(actions: CarPlayActions) {
    this.actions = actions;
  }

  private load(): boolean {
    if (Platform.OS !== "ios") return false;
    if (this.rnc) return true;
    try {

      const { NativeModules } = require("react-native") as {
        NativeModules: Record<string, unknown>;
      };
      carPlayLog(
        `NativeModules.RNCarPlay ${NativeModules.RNCarPlay ? "present" : "MISSING"}`,
      );

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

  private installParseConfigShim(mod: RNCarPlay) {
    try {

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

  register() {
    if (this.registered) return;
    carPlayLog("session.register() called");
    if (!this.load() || !this.CarPlay) {
      carPlayLog("session.register() bailed — CarPlay bridge unavailable");
      return;
    }
    this.registered = true;

    const handleConnect = () => {

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

    if (this.CarPlay.connected) {
      carPlayLog("replaying already-connected CarPlay session");
      handleConnect();
    } else {

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

    }
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch (error) {
        carPlayLog(`connection listener FAILED: ${String(error)}`);
      }
    }
  }

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

  private decorateRow(row: HomeRow) {
    let image: ImageSourcePropType | undefined;
    if (row.action.kind === "talk") {
      image = this.phase === "listening" ? LISTENING_ICON : MIC_ICON;
    } else if (row.action.kind === "readLatest") {
      image = REPLAY_ICON;
    }
    return { ...row.item, image };
  }

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

  setConverseMode(on: boolean) {
    if (this.converseOn === on) return;
    this.converseOn = on;
    this.render();
  }

  getConverseMode(): boolean {
    return this.converseOn;
  }

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

  setPhase(phase: CarPlayPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.render();
  }

  getPhase(): CarPlayPhase {
    return this.phase;
  }

  setReplyPreview(text: string) {
    this.speakingPreview = text;
    if (this.phase === "speaking") this.render();
  }

  private render() {
    if (!this.connected || !this.listTemplate) return;
    try {
      const home = this.currentHome();
      const rowActions = flattenActions(home);
      this.listTemplate.updateSections(
        home.map((section) => ({
          header: section.header,
          items: section.rows.map((row) => this.decorateRow(row)),
        })),
      );

      this.rowActions = rowActions;
    } catch (error) {
      carPlayLog(`failed to update home rows: ${String(error)}`);
    }
  }
}

export const carPlaySession = new CarPlaySession();
