/**
 * Stella's CarPlay surface controller.
 *
 * CarPlay only lets us drive Apple's templates (we can't render arbitrary RN
 * views on the head unit), so this is an imperative state machine over the
 * `react-native-carplay` bridge rather than a React tree. It owns exactly two
 * surfaces, both reachable under the CarPlay **audio** entitlement:
 *
 *   1. Voice home   → a `CPListTemplate` root (the big tap-to-talk affordance)
 *      with the live `CPVoiceControlTemplate` presented over it as Stella
 *      listens and thinks — the glance-free voice/listening interaction.
 *   2. Replay card  → a `CPNowPlayingTemplate` for the last spoken reply, with
 *      a one-tap Stella-green Replay control wired back to the TTS.
 *
 * The actual chat send + dictation + text-to-speech all live in the existing
 * mobile plumbing; {@link CarPlayBridge} hooks those up and drives the phases
 * here. This module never imports `react-native-carplay` at module scope (its
 * singleton instantiates a NativeEventEmitter on construction, which throws on
 * platforms without the native module) — it lazy-`require`s it on iOS only.
 */

import { Platform, type ImageSourcePropType } from "react-native";

export type CarPlayPhase = "idle" | "listening" | "thinking" | "speaking";

/** Callbacks the bridge binds so CarPlay taps drive the real voice loop. */
export type CarPlayActions = {
  /** The single tap-to-talk row was selected (toggles record → send). */
  onTalk: () => void;
  /** The Replay control on the now-playing card was pressed. */
  onReplay: () => void;
};

// Stella-green glyphs (see assets/carplay/generate-icons.py). Carrying the
// brand's success/ok green into the few tintable template slots is the closest
// CarPlay lets us get to Stella's visual language.
const MIC_ICON = require("../../assets/carplay/stella-voice-mic.png") as ImageSourcePropType;
const REPLAY_ICON = require("../../assets/carplay/stella-voice-replay.png") as ImageSourcePropType;
const LISTENING_ICON = require("../../assets/carplay/stella-voice-listening.png") as ImageSourcePropType;

const VOICE_STATE_LISTENING = "stella-listening";
const VOICE_STATE_THINKING = "stella-thinking";

// Copy mirrors the phone app's tone ("Ask Stella anything", "Message Stella").
const PHASE_COPY: Record<
  CarPlayPhase,
  { title: string; subtitle: string }
> = {
  idle: { title: "Talk to Stella", subtitle: "Tap to speak — hands free" },
  listening: { title: "Listening…", subtitle: "Tap again to send" },
  thinking: { title: "Stella is thinking…", subtitle: "One moment" },
  speaking: { title: "Stella is speaking", subtitle: "Tap to replay" },
};

type RNCarPlay = typeof import("react-native-carplay");

class CarPlaySession {
  private rnc: RNCarPlay | null = null;
  private CarPlay: RNCarPlay["CarPlay"] | null = null;

  private actions: CarPlayActions | null = null;
  private phase: CarPlayPhase = "idle";
  private replyPreview = "";

  private listTemplate: InstanceType<RNCarPlay["ListTemplate"]> | null = null;
  private voiceTemplate:
    | InstanceType<RNCarPlay["VoiceControlTemplate"]>
    | null = null;
  private nowPlayingTemplate:
    | InstanceType<RNCarPlay["NowPlayingTemplate"]>
    | null = null;

  private registered = false;
  private connected = false;
  private voicePresented = false;
  private replayPushed = false;

  /** Bind (or rebind) the live action closures from the React bridge. */
  bindActions(actions: CarPlayActions) {
    this.actions = actions;
  }

  /** Lazily load react-native-carplay on iOS; no-op elsewhere. */
  private load(): boolean {
    if (Platform.OS !== "ios") return false;
    if (this.rnc) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("react-native-carplay") as RNCarPlay;
      this.rnc = mod;
      this.CarPlay = mod.CarPlay;
      return true;
    } catch (error) {
      console.warn("[carplay] react-native-carplay unavailable", error);
      return false;
    }
  }

  /** Register connect/disconnect handlers exactly once (called on iOS mount). */
  register() {
    if (this.registered) return;
    if (!this.load() || !this.CarPlay) return;
    this.registered = true;

    const handleConnect = () => {
      // This whole callback runs the first time a real head unit hands us its
      // interface controller. Any throw in here (a template constructor
      // rejecting its contents, a brand asset that won't resolve, or a CarPlay
      // API raising on the head unit) is an exception inside a native-event
      // listener — unguarded it surfaces as an unhandled JS error on connect
      // and can take the phone app down mid-drive. Keep the entire connect path
      // fail-safe: on error the native placeholder remains visible rather than
      // leaving the head unit blank. Note `buildTemplates()` and `renderPhase()`
      // were previously outside the try, so a failure constructing the templates
      // was not contained.
      try {
        console.info("[carplay] JS connect handler running");
        this.connected = true;
        this.buildTemplates();
        this.phase = "idle";
        this.replayPushed = false;
        this.voicePresented = false;
        this.CarPlay!.setRootTemplate(this.listTemplate!, false);
        this.CarPlay!.enableNowPlaying(true);
        this.renderPhase();
      } catch (error) {
        console.warn("[carplay] connect handler failed", error);
      }
    };

    this.CarPlay.registerOnConnect(handleConnect);

    // react-native-carplay checks RNCPStore for an existing connection inside
    // its module constructor. If the car connected before this singleton was
    // registered, that replay fires while `onConnectCallbacks` is still empty:
    // `CarPlay.connected` becomes true, but Stella never gets a chance to set
    // the root template. Replay the already-connected state after registering
    // our callback, and ask native to re-check in case its first replay arrived
    // between construction and this registration.
    if (this.CarPlay.connected) {
      console.info("[carplay] replaying already-connected CarPlay session");
      handleConnect();
    } else {
      this.CarPlay.bridge?.checkForConnection?.();
    }

    this.CarPlay.registerOnDisconnect(() => {
      this.connected = false;
      this.voicePresented = false;
      this.replayPushed = false;
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  private buildTemplates() {
    if (!this.rnc) return;
    const { ListTemplate, VoiceControlTemplate, NowPlayingTemplate } = this.rnc;

    this.listTemplate = new ListTemplate({
      id: "stella-voice-home",
      title: "Stella",
      sections: [{ items: [this.homeItem()] }],
      onItemSelect: async () => {
        this.actions?.onTalk();
      },
    });

    this.voiceTemplate = new VoiceControlTemplate({
      voiceControlStates: [
        {
          identifier: VOICE_STATE_LISTENING,
          titleVariants: ["Listening…", "Listening"],
          image: LISTENING_ICON,
          repeats: true,
        },
        {
          identifier: VOICE_STATE_THINKING,
          titleVariants: ["Stella is thinking…", "Thinking…", "Thinking"],
          image: LISTENING_ICON,
          repeats: true,
        },
      ],
    });

    this.nowPlayingTemplate = new NowPlayingTemplate({
      id: "stella-replay-card",
      buttons: [
        { id: "replay", type: "image", image: REPLAY_ICON },
        { id: "talk", type: "image", image: MIC_ICON },
      ],
      onButtonPressed: ({ id }) => {
        if (id === "replay") this.actions?.onReplay();
        else if (id === "talk") this.actions?.onTalk();
      },
    });
  }

  private homeItem() {
    const copy = PHASE_COPY[this.phase];
    return {
      text: copy.title,
      detailText:
        this.phase === "speaking" && this.replyPreview
          ? this.replyPreview
          : copy.subtitle,
      image: MIC_ICON,
      isPlaying: this.phase === "listening" || this.phase === "thinking",
    };
  }

  /** Move to a new phase and reconcile the visible templates. */
  setPhase(phase: CarPlayPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.renderPhase();
  }

  /** Short preview of the last reply, shown on the home row + replay card. */
  setReplyPreview(text: string) {
    this.replyPreview = text.replace(/\s+/g, " ").trim().slice(0, 120);
    if (this.phase === "speaking") this.refreshHome();
  }

  private refreshHome() {
    if (!this.connected || !this.listTemplate) return;
    try {
      this.listTemplate.updateSections([{ items: [this.homeItem()] }]);
    } catch (error) {
      console.warn("[carplay] failed to update home", error);
    }
  }

  private renderPhase() {
    if (!this.connected || !this.CarPlay) return;
    this.refreshHome();

    switch (this.phase) {
      case "idle": {
        this.dismissVoice();
        this.popReplay();
        break;
      }
      case "listening": {
        this.popReplay();
        this.presentVoice(VOICE_STATE_LISTENING);
        break;
      }
      case "thinking": {
        this.presentVoice(VOICE_STATE_THINKING);
        break;
      }
      case "speaking": {
        this.dismissVoice();
        this.pushReplay();
        break;
      }
    }
  }

  private presentVoice(stateId: string) {
    if (!this.CarPlay || !this.voiceTemplate) return;
    try {
      if (!this.voicePresented) {
        this.CarPlay.presentTemplate(this.voiceTemplate, true);
        this.voicePresented = true;
      }
      this.voiceTemplate.activateVoiceControlState(stateId);
    } catch (error) {
      console.warn("[carplay] failed to present voice template", error);
    }
  }

  private dismissVoice() {
    if (!this.CarPlay || !this.voicePresented) return;
    try {
      this.CarPlay.dismissTemplate(true);
    } catch (error) {
      console.warn("[carplay] failed to dismiss voice template", error);
    }
    this.voicePresented = false;
  }

  private pushReplay() {
    if (!this.CarPlay || !this.nowPlayingTemplate || this.replayPushed) return;
    try {
      this.CarPlay.pushTemplate(this.nowPlayingTemplate, true);
      this.replayPushed = true;
    } catch (error) {
      console.warn("[carplay] failed to push replay card", error);
    }
  }

  private popReplay() {
    if (!this.CarPlay || !this.replayPushed) return;
    try {
      this.CarPlay.popToRootTemplate(true);
    } catch (error) {
      console.warn("[carplay] failed to pop replay card", error);
    }
    this.replayPushed = false;
  }
}

/** App-wide singleton; the bridge binds actions and drives phases on it. */
export const carPlaySession = new CarPlaySession();
