import type {
  MediaStream,
  RTCPeerConnection as NativeRTCPeerConnection,
} from "react-native-webrtc";
import type { ChatMessage, MobileTask } from "../types";
import type { StoredPhoneAccess } from "./phone-access";
import {
  VOICE_LEASE_HEADER,
  VOICE_LIVE_SDP_PATH,
  type VoiceHistoryMessage,
  type VoiceLeaseEvent,
} from "@stella/contracts/backend/voice";
import { getBackendClient } from "./backend";
import { postText } from "./http";
import {
  buildAttachedChatVoiceHistory,
  buildComputerVoiceHistory,
  buildVoiceAppendEvent,
  buildVoiceCloseEvent,
  buildVoiceMicrophoneEvent,
  buildVoiceSessionInstructions,
  findVoiceActionCompletion,
  parseVoiceAppendAck,
  parseVoiceDelegationCreated,
  parseVoiceTranscriptDelta,
  realtimeErrorMessage,
  splitVoiceAppendContent,
  VoiceTranscriptAccumulator,
  type RealtimeVoiceActionDispatch,
  type RealtimeVoicePhase,
  type VoiceAppendKind,
} from "./realtime-voice-protocol";
import {
  connectDesktopRealtimeVoice,
  persistDesktopRealtimeVoiceTranscript,
  type DesktopRealtimeVoice,
} from "./desktop-realtime-voice";
import { REALTIME_VOICE_AUDIO_MODE } from "./realtime-voice-audio";
import { ensureMicrophonePermission } from "./microphone-permission";
import {
  acquireRecordingAudioSession,
  refreshRecordingAudioSession,
  releaseRecordingAudioSession,
  type RecordingAudioLease,
} from "./mobile-audio-session";

const DATA_CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const LEASE_HEARTBEAT_MS = 2_000;
const LEASE_REQUEST_TIMEOUT_MS = 1_500;
const LEASE_MAX_LOCAL_LIFETIME_MS = 10_000;
const LEASE_EXPIRY_SKEW_MS = 1_000;
const SESSION_REQUEST_TIMEOUT_MS = 20_000;
const SESSION_START_TIMEOUT_MS = 10_000;
const SESSION_CLOSE_DRAIN_MS = 1_500;
const SDP_NEGOTIATION_TIMEOUT_MS = 8_000;
const DISCONNECTED_GRACE_MS = 10_000;
/** Transcript deltas are the only speech signal GPT-Live sends on the channel. */
const USER_SPEECH_IDLE_MS = 900;
const ASSISTANT_SPEECH_IDLE_MS = 1_200;
const MAX_DELEGATION_RESULT_CHARS = 6_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Request timed out. Try again.")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export type RealtimeVoiceSnapshot = {
  phase: RealtimeVoicePhase;
  isConnected: boolean;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
  transcript: string;
  error: string | null;
};

export const INITIAL_REALTIME_VOICE_SNAPSHOT: RealtimeVoiceSnapshot = {
  phase: "connecting",
  isConnected: false,
  isUserSpeaking: false,
  isAssistantSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
  transcript: "",
  error: null,
};

export class RealtimeVoicePermissionError extends Error {
  constructor() {
    super("Microphone access is needed for realtime voice.");
    this.name = "RealtimeVoicePermissionError";
  }
}

type SessionOptions = {
  conversationId: string;
  messages: ChatMessage[];
  execution: "phone" | "computer";
  desktopAccess?: StoredPhoneAccess | null;
  onSnapshot: (snapshot: RealtimeVoiceSnapshot) => void;
  onPerformAction: (request: string) => Promise<RealtimeVoiceActionDispatch>;
  onEndRequested: () => void;
};

type DataChannel = ReturnType<NativeRTCPeerConnection["createDataChannel"]> & {
  addEventListener: (
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) => void;
};

type PeerConnection = NativeRTCPeerConnection & {
  addEventListener: (type: string, listener: () => void) => void;
};

/** One voice request handed to the orchestrator, keyed by its chat turn. */
type DelegatedRequest = {
  delegationId: string;
  transcript: string;
  superseded: boolean;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Stable append id for one persisted voice transcript row. The desktop's cloud
 * journal dedupes on it, so a retried send can never duplicate a line.
 * Matches the runtime's `[A-Za-z0-9._:-]{1,128}` append-id contract.
 */
export const desktopVoiceTranscriptEventId = (
  requestId: string,
  role: "user" | "assistant",
  itemId: string,
): string => {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-");
  return `voice:${clean(requestId)}:${role}:${clean(itemId)}`.slice(0, 128);
};

const clearlyEndsConversation = (text: string): boolean =>
  /^(?:okay[, ]*)?(?:bye|goodbye|good night|goodnight|see you|talk (?:to you )?later)[.! ]*$/i.test(
    text.trim(),
  );

const formatVoiceSessionDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
};

const waitForDataChannelOpen = (channel: DataChannel): Promise<void> =>
  new Promise((resolve, reject) => {
    if (channel.readyState === "open") {
      resolve();
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onClose = () =>
      finish(new Error("The realtime voice connection closed during setup."));
    const timer = setTimeout(
      () => finish(new Error("Realtime voice took too long to connect.")),
      DATA_CHANNEL_OPEN_TIMEOUT_MS,
    );
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
  });

/**
 * One foreground mobile GPT-Live session in client-delegation mode. The voice
 * model holds the spoken conversation full-duplex; every delegation it opens
 * becomes an orchestrator turn in the attached Stella chat — the same path a
 * typed message takes — and its result comes back as spoken commentary.
 *
 * The lifecycle stays bounded to the full-screen surface: closing the surface
 * closes the microphone, the peer, and the backend lease.
 */
export class MobileRealtimeVoiceSession {
  private readonly options: SessionOptions;
  private readonly requestId =
    globalThis.crypto?.randomUUID?.() ??
    `mobile-voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private pc: PeerConnection | null = null;
  private channel: DataChannel | null = null;
  private localStream: MediaStream | null = null;
  private token: {
    model: string;
    voice: string;
    leaseId: string;
    leaseExpiresAt: number;
  } | null = null;
  private desktopVoice: DesktopRealtimeVoice | null = null;
  private connectedAt: number | null = null;
  private snapshot: RealtimeVoiceSnapshot = {
    ...INITIAL_REALTIME_VOICE_SNAPSHOT,
  };
  private started = false;
  private stopped = false;
  private stopEvent: "ended" | "lost" | "expired" = "ended";
  private leaseTerminalReported = false;
  private audioLease: RecordingAudioLease | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private userSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private assistantSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private sdpAbortController: AbortController | null = null;
  private sessionStartWaiter: { finish: (error?: Error) => void } | null = null;
  private sessionCloseWaiter: (() => void) | null = null;
  private sessionLive = false;
  private persistedDesktopTranscripts = new Set<string>();
  private handledDelegations = new Set<string>();
  private delegatedRequests = new Map<string, DelegatedRequest>();
  private pendingAppends = new Map<string, VoiceAppendKind>();
  private appendSequence = 0;
  private closeAfterNextSpokenReply = false;
  private userTranscript = new VoiceTranscriptAccumulator();
  private assistantTranscript = new VoiceTranscriptAccumulator();

  constructor(options: SessionOptions) {
    this.options = options;
  }

  /**
   * Interrupting speech never cancels backend work, so settled chat results are
   * returned to the live conversation whenever they land: spoken commentary for
   * work the user still wants, silent context for a request they superseded.
   */
  syncAssistantMessages(
    messages: ChatMessage[],
    tasks: readonly MobileTask[],
    chatBusy: boolean,
  ): void {
    if (chatBusy || !this.snapshot.isConnected || this.stopped) return;
    for (const [requestId, request] of [...this.delegatedRequests]) {
      const completion = findVoiceActionCompletion(messages, requestId, tasks);
      if (!completion) continue;
      this.delegatedRequests.delete(requestId);
      const result = completion.text.slice(0, MAX_DELEGATION_RESULT_CHARS);
      if (request.superseded) {
        this.sendAppend(
          "thinking",
          request.delegationId,
          [
            `The user replaced this earlier request: "${request.transcript}". Do not announce its result unless they ask.`,
            completion.failed
              ? `It failed: ${result}`
              : `It returned: ${result}`,
          ].join("\n"),
        );
        continue;
      }
      this.sendAppend(
        "commentary",
        request.delegationId,
        completion.failed ? `That did not work out: ${result}` : result,
      );
    }
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.publish({ ...INITIAL_REALTIME_VOICE_SNAPSHOT });

    try {
      // The composer resolves microphone access before this surface opens, so
      // this normally reuses an existing grant without a system prompt.
      const permission = await ensureMicrophonePermission();
      if (!permission.granted) throw new RealtimeVoicePermissionError();

      this.audioLease = await acquireRecordingAudioSession(
        REALTIME_VOICE_AUDIO_MODE,
      );
      if (this.audioLease === null) {
        throw new Error("Another microphone session replaced realtime voice.");
      }
      // Keep the native module lazy so an older binary receiving the JS bundle
      // can still launch and show a useful upgrade error instead of crashing
      // when ChatPane is imported.
      const { mediaDevices, RTCPeerConnection } =
        await import("react-native-webrtc");
      this.localStream = await mediaDevices.getUserMedia({
        // The native iOS/Android audio route applies its built-in voice
        // processing; this package's constraint type does not expose the
        // browser-only echo/noise/AGC keys.
        audio: true,
        video: false,
      });
      if (this.stopped) {
        await this.releaseConnection();
        return;
      }

      let history: VoiceHistoryMessage[];
      if (this.options.execution === "computer") {
        if (!this.options.desktopAccess) {
          throw new Error(
            "Connect this phone to a computer before starting realtime voice.",
          );
        }
        this.desktopVoice = await connectDesktopRealtimeVoice(
          this.options.desktopAccess,
          this.options.conversationId,
        );
        history = buildComputerVoiceHistory(this.desktopVoice.config);
      } else {
        history = buildAttachedChatVoiceHistory(this.options.messages);
      }
      const instructions = buildVoiceSessionInstructions(
        this.options.execution,
      );
      const session = await withTimeout(
        getBackendClient().call("voice.session", {
          instructions,
          ...(history.length ? { history } : {}),
        }),
        SESSION_REQUEST_TIMEOUT_MS,
      );
      this.token = {
        model: session.model,
        voice: session.voice,
        leaseId: session.leaseId,
        leaseExpiresAt: session.leaseExpiresAt,
      };
      if (this.stopped) {
        const cleanup = this.releaseConnection();
        const terminalReport = this.reportLeaseTerminal(this.stopEvent);
        await Promise.allSettled([cleanup, terminalReport]);
        return;
      }
      this.startLeaseReporting();

      const pc = new RTCPeerConnection({
        iceCandidatePoolSize: 1,
      }) as PeerConnection;
      this.pc = pc;
      const track = this.localStream.getAudioTracks()[0];
      if (!track) throw new Error("No microphone track is available.");
      track.enabled = false;
      pc.addTrack(track, this.localStream);

      // The event channel has to exist before the offer is created so it is
      // part of the negotiated session.
      const channel = pc.createDataChannel("oai-events") as DataChannel;
      this.channel = channel;
      this.installConnectionListeners(pc, channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.stopped) return;
      const localSdp = pc.localDescription?.sdp ?? offer.sdp;
      if (!localSdp) throw new Error("Could not create a voice connection.");

      const sdpAbortController = new AbortController();
      this.sdpAbortController = sdpAbortController;
      let negotiationTimedOut = false;
      const sdpTimeout = setTimeout(() => {
        negotiationTimedOut = true;
        sdpAbortController.abort();
      }, SDP_NEGOTIATION_TIMEOUT_MS);
      let sdpAnswer: string;
      try {
        sdpAnswer = await postText(VOICE_LIVE_SDP_PATH, localSdp, {
          headers: {
            "Content-Type": "application/sdp",
            [VOICE_LEASE_HEADER]: session.leaseId,
          },
          signal: sdpAbortController.signal,
          timeoutMs: SDP_NEGOTIATION_TIMEOUT_MS,
        });
      } catch (error) {
        if (negotiationTimedOut) {
          throw new Error("Realtime voice negotiation took too long.");
        }
        throw error;
      } finally {
        clearTimeout(sdpTimeout);
        if (this.sdpAbortController === sdpAbortController) {
          this.sdpAbortController = null;
        }
      }
      await pc.setRemoteDescription({
        type: "answer",
        sdp: sdpAnswer,
      });
      await waitForDataChannelOpen(channel);
      if (this.stopped) return;

      // Instructions, voice and startup history are set when the backend
      // creates the session, so nothing is configured from here. The session
      // announces itself and only then accepts commands.
      await this.waitForSessionStarted();
      if (this.stopped) return;
      this.sessionLive = true;
      this.setMicrophoneMuted(false);
      track.enabled = true;
      // WebRTC activates its own call-style iOS audio session after the first
      // configuration above. Reassert Stella's assistant-style loudspeaker
      // route after the peer and microphone are both live.
      await this.ensureLoudspeakerRoute();
      this.connectedAt = Date.now();
      this.publish({
        phase: "listening",
        isConnected: true,
        error: null,
      });
    } catch (error) {
      if (this.stopped) return;
      const rawMessage =
        error instanceof Error
          ? error.message
          : "Could not start realtime voice.";
      const message = rawMessage.includes("WebRTC native module not found")
        ? "Realtime voice needs a newer Stella app build."
        : rawMessage;
      this.publish({
        phase: "error",
        isConnected: false,
        isUserSpeaking: false,
        isAssistantSpeaking: false,
        micLevel: 0,
        outputLevel: 0,
        error: message,
      });
      const cleanup = this.releaseConnection();
      const terminalReport = this.reportLeaseTerminal("lost");
      await Promise.allSettled([cleanup, terminalReport]);
    }
  }

  async stop(event: "ended" | "lost" | "expired" = "ended"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopEvent = event;
    const cleanup = this.releaseConnection();
    const terminalReport = this.reportLeaseTerminal(event);
    await Promise.allSettled([cleanup, terminalReport]);
  }

  private publish(patch: Partial<RealtimeVoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onSnapshot(this.snapshot);
  }

  private installConnectionListeners(pc: PeerConnection, channel: DataChannel) {
    channel.addEventListener("message", (message) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(asString(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleServerEvent(event);
    });
    channel.addEventListener("close", () => {
      if (this.stopped || !this.snapshot.isConnected) return;
      void this.failConnection("The realtime voice connection closed.");
    });
    channel.addEventListener("error", () => {
      if (this.stopped) return;
      void this.failConnection(
        "The realtime voice connection was interrupted.",
      );
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.stopped) return;
      if (pc.connectionState === "failed") {
        this.clearDisconnectedTimer();
        void this.failConnection(
          "The realtime voice connection was interrupted.",
        );
        return;
      }
      if (pc.connectionState === "disconnected") {
        if (this.disconnectedTimer) return;
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          if (
            this.stopped ||
            this.pc !== pc ||
            pc.connectionState !== "disconnected"
          ) {
            return;
          }
          void this.failConnection(
            "The realtime voice connection was interrupted.",
          );
        }, DISCONNECTED_GRACE_MS);
        return;
      }
      this.clearDisconnectedTimer();
    });
  }

  private handleServerEvent(event: Record<string, unknown>) {
    const type = asString(event.type);
    switch (type) {
      case "session.started":
        this.sessionStartWaiter?.finish();
        return;
      case "session.closed":
        this.sessionLive = false;
        if (this.sessionCloseWaiter) {
          this.sessionCloseWaiter();
          return;
        }
        void this.failConnection(
          "This voice session ended. Start a new one to keep talking.",
        );
        return;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        this.handleTranscriptDelta(event);
        return;
      case "session.delegation.created":
        void this.handleDelegation(event);
        return;
      case "error":
        if (this.sessionStartWaiter) {
          this.sessionStartWaiter.finish(
            new Error(realtimeErrorMessage(event)),
          );
          return;
        }
        this.resolveAppendAck(event);
        return;
      default:
        this.resolveAppendAck(event);
        return;
    }
  }

  private handleTranscriptDelta(event: Record<string, unknown>) {
    const fragment = parseVoiceTranscriptDelta(event);
    if (!fragment) return;
    if (fragment.role === "user") {
      const transcript = this.userTranscript.append(fragment);
      this.publish({
        transcript,
        phase: this.snapshot.isAssistantSpeaking
          ? "assistant-speaking"
          : "user-speaking",
        isUserSpeaking: true,
        micLevel: 0.28,
      });
      if (this.userSpeechTimer) clearTimeout(this.userSpeechTimer);
      this.userSpeechTimer = setTimeout(() => {
        this.userSpeechTimer = null;
        if (this.stopped) return;
        this.publish({
          phase: this.snapshot.isAssistantSpeaking
            ? "assistant-speaking"
            : "listening",
          isUserSpeaking: false,
          micLevel: 0,
        });
        void this.persistComputerTranscript("user", this.userTranscript.text);
      }, USER_SPEECH_IDLE_MS);
      return;
    }
    const transcript = this.assistantTranscript.append(fragment);
    // iOS can reapply WebRTC's receiver route when remote audio starts, so the
    // loudspeaker is reasserted at the playback boundary too.
    if (!this.snapshot.isAssistantSpeaking) void this.ensureLoudspeakerRoute();
    this.publish({
      transcript,
      phase: "assistant-speaking",
      isAssistantSpeaking: true,
      outputLevel: 0.36,
    });
    if (this.assistantSpeechTimer) clearTimeout(this.assistantSpeechTimer);
    this.assistantSpeechTimer = setTimeout(() => {
      this.assistantSpeechTimer = null;
      if (this.stopped) return;
      this.publish({
        phase: this.snapshot.isUserSpeaking ? "user-speaking" : "listening",
        isAssistantSpeaking: false,
        outputLevel: 0,
      });
      void this.persistComputerTranscript(
        "assistant",
        this.assistantTranscript.take(),
      );
      if (this.closeAfterNextSpokenReply) {
        this.closeAfterNextSpokenReply = false;
        this.options.onEndRequested();
      }
    }, ASSISTANT_SPEECH_IDLE_MS);
  }

  /**
   * The voice model asked for work. The event carries no task text, so the
   * request is the accumulated spoken turn plus what the app knows about this
   * call, and it runs as an ordinary orchestrator turn in the attached chat.
   */
  private async handleDelegation(event: Record<string, unknown>) {
    const delegation = parseVoiceDelegationCreated(event);
    if (!delegation || this.handledDelegations.has(delegation.id)) return;
    this.handledDelegations.add(delegation.id);
    const transcript = this.userTranscript.take();
    if (!transcript) {
      this.sendAppend(
        "thinking",
        delegation.id,
        "Nothing was transcribed for that request. Ask the user to say it again.",
      );
      return;
    }
    const pendingCount = this.delegatedRequests.size;
    const request = [
      transcript,
      "",
      "<voice_call>",
      this.options.execution === "computer"
        ? "The user said this aloud in a live voice call, with work running on their connected computer."
        : "The user said this aloud in a live voice call attached to this chat.",
      "Answer in one to three short sentences that read well spoken aloud.",
      pendingCount
        ? `${pendingCount} earlier request${pendingCount === 1 ? "" : "s"} from this call ${pendingCount === 1 ? "is" : "are"} still running.`
        : "",
      "</voice_call>",
    ]
      .filter((line) => line !== "")
      .join("\n");

    let dispatch: RealtimeVoiceActionDispatch = null;
    try {
      dispatch = await this.options.onPerformAction(request);
    } catch {
      dispatch = null;
    }
    if (this.stopped) return;
    if (!dispatch) {
      this.sendAppend(
        "thinking",
        delegation.id,
        "Stella's chat could not accept that request. Tell the user briefly and ask them to try again.",
      );
      return;
    }
    // A request the user amended mid-sentence is superseded by this one: its
    // work keeps running, but its answer is no longer what they asked for.
    for (const pending of this.delegatedRequests.values()) {
      if (
        !pending.superseded &&
        transcript !== pending.transcript &&
        transcript.startsWith(pending.transcript)
      ) {
        pending.superseded = true;
      }
    }
    this.delegatedRequests.set(dispatch.userMessageId, {
      delegationId: delegation.id,
      transcript,
      superseded: false,
    });
    this.sendAppend(
      "thinking",
      delegation.id,
      "Stella's orchestrator is handling this request. Keep the user company and wait for the result instead of answering it yourself.",
    );
    if (clearlyEndsConversation(transcript)) {
      this.closeAfterNextSpokenReply = true;
    }
  }

  private sendAppend(
    kind: VoiceAppendKind,
    delegationId: string | null,
    content: string,
  ) {
    for (const chunk of splitVoiceAppendContent(content)) {
      this.appendSequence += 1;
      const eventId = `${this.requestId}:${kind}:${this.appendSequence}`;
      this.pendingAppends.set(eventId, kind);
      this.send(
        buildVoiceAppendEvent({
          kind,
          eventId,
          delegationId,
          content: chunk,
        }),
      );
    }
  }

  private resolveAppendAck(event: Record<string, unknown>) {
    const ack = parseVoiceAppendAck(event);
    if (!ack) return;
    const kind = this.pendingAppends.get(ack.clientEventId);
    if (!kind) return;
    this.pendingAppends.delete(ack.clientEventId);
    if (ack.error) {
      console.debug(`[realtime-voice] ${kind} append rejected:`, ack.error);
    }
  }

  private setMicrophoneMuted(muted: boolean) {
    this.appendSequence += 1;
    this.send(
      buildVoiceMicrophoneEvent({
        eventId: `${this.requestId}:mic:${this.appendSequence}`,
        muted,
      }),
    );
  }

  private async persistComputerTranscript(
    role: "user" | "assistant",
    transcript: string,
  ) {
    if (!this.desktopVoice || !transcript) return;
    const key = `${role}:${transcript}`;
    if (this.persistedDesktopTranscripts.has(key)) return;
    this.persistedDesktopTranscripts.add(key);
    try {
      await persistDesktopRealtimeVoiceTranscript(this.desktopVoice, {
        conversationId: this.options.conversationId,
        eventId: desktopVoiceTranscriptEventId(
          this.requestId,
          role,
          `${this.persistedDesktopTranscripts.size}`,
        ),
        timestamp: Date.now(),
        role,
        text: transcript,
        uiVisibility: "hidden",
      });
    } catch (error) {
      console.debug(
        "[realtime-voice] Desktop transcript persistence failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private waitForSessionStarted(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.sessionStartWaiter?.finish === finish) {
          this.sessionStartWaiter = null;
        }
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("The voice session took too long to start.")),
        SESSION_START_TIMEOUT_MS,
      );
      this.sessionStartWaiter = { finish };
    });
  }

  /** Ask the session to close and keep receiving until it confirms. */
  private async closeLiveSession(): Promise<void> {
    if (!this.sessionLive || this.channel?.readyState !== "open") return;
    this.sessionLive = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.sessionCloseWaiter === finish) this.sessionCloseWaiter = null;
        resolve();
      };
      const timer = setTimeout(finish, SESSION_CLOSE_DRAIN_MS);
      this.sessionCloseWaiter = finish;
      this.setMicrophoneMuted(true);
      this.appendSequence += 1;
      this.send(
        buildVoiceCloseEvent(`${this.requestId}:close:${this.appendSequence}`),
      );
    });
  }

  private async ensureLoudspeakerRoute(): Promise<void> {
    const lease = this.audioLease;
    if (lease === null) return;
    try {
      await refreshRecordingAudioSession(lease, REALTIME_VOICE_AUDIO_MODE);
    } catch (error) {
      // A transient OS route failure should not tear down an otherwise healthy
      // session; the next assistant reply retries the route.
      console.debug(
        "[realtime-voice] Could not route output through the loudspeaker:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private clearDisconnectedTimer() {
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private send(event: Record<string, unknown>) {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(JSON.stringify(event));
  }

  private startLeaseReporting() {
    if (!this.token) return;
    this.scheduleLeaseExpiry(this.token.leaseExpiresAt);
    void this.reportLeaseEvent("heartbeat");
    this.heartbeatTimer = setInterval(() => {
      void this.reportLeaseEvent("heartbeat");
    }, LEASE_HEARTBEAT_MS);
  }

  private scheduleLeaseExpiry(leaseExpiresAt: number) {
    if (this.leaseExpiryTimer) clearTimeout(this.leaseExpiryTimer);
    this.leaseExpiryTimer = null;
    if (this.stopped) return;
    // Cap the absolute server timestamp to one lease lifetime so a device
    // clock that is behind cannot accidentally keep the provider peer alive.
    const remainingMs = Math.min(
      LEASE_MAX_LOCAL_LIFETIME_MS,
      leaseExpiresAt - Date.now(),
    );
    const delay = Math.max(0, remainingMs - LEASE_EXPIRY_SKEW_MS);
    this.leaseExpiryTimer = setTimeout(() => {
      this.leaseExpiryTimer = null;
      if (this.stopped) return;
      this.publish({
        phase: "error",
        isConnected: false,
        isUserSpeaking: false,
        isAssistantSpeaking: false,
        micLevel: 0,
        outputLevel: 0,
        error: "This voice session expired. Start a new one to keep talking.",
      });
      void this.stop("expired");
    }, delay);
  }

  private async reportLeaseEvent(event: VoiceLeaseEvent) {
    const token = this.token;
    if (!token) return;
    const { leaseId } = token;
    try {
      const response = await withTimeout(
        getBackendClient().call("voice.lease", { leaseId, event }),
        LEASE_REQUEST_TIMEOUT_MS,
      );
      if (
        event !== "heartbeat" ||
        this.stopped ||
        this.token?.leaseId !== leaseId
      ) {
        return;
      }
      if (
        response.directive === "continue" &&
        response.leaseExpiresAt !== null
      ) {
        this.token.leaseExpiresAt = response.leaseExpiresAt;
        this.scheduleLeaseExpiry(response.leaseExpiresAt);
        return;
      }
      await this.closeForLeaseLoss(response.reason);
    } catch {
      // The last renewed lease expiry is still enforced by the local timer,
      // so a black-holed poll cannot leave WebRTC alive.
    }
  }

  /** The server closed the lease: stop without reporting a terminal event. */
  private async closeForLeaseLoss(reason: string | null) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopEvent = "lost";
    this.leaseTerminalReported = true;
    this.publish({
      phase: "error",
      isConnected: false,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      micLevel: 0,
      outputLevel: 0,
      error:
        reason === "session_expired"
          ? "This voice session expired. Start a new one to keep talking."
          : "This voice session was closed by Stella. Start a new one to keep talking.",
    });
    await this.releaseConnection();
  }

  private async reportLeaseTerminal(event: "ended" | "expired" | "lost") {
    if (this.leaseTerminalReported) return;
    if (!this.token) return;
    this.leaseTerminalReported = true;
    await this.reportLeaseEvent(event);
  }

  private async failConnection(message: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopEvent = "lost";
    this.publish({
      phase: "error",
      isConnected: false,
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      micLevel: 0,
      outputLevel: 0,
      error: message,
    });
    const cleanup = this.releaseConnection();
    const terminalReport = this.reportLeaseTerminal("lost");
    await Promise.allSettled([cleanup, terminalReport]);
  }

  private async releaseConnection() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.leaseExpiryTimer) clearTimeout(this.leaseExpiryTimer);
    if (this.userSpeechTimer) clearTimeout(this.userSpeechTimer);
    if (this.assistantSpeechTimer) clearTimeout(this.assistantSpeechTimer);
    this.clearDisconnectedTimer();
    this.sdpAbortController?.abort();
    this.sdpAbortController = null;
    this.heartbeatTimer = null;
    this.leaseExpiryTimer = null;
    this.userSpeechTimer = null;
    this.assistantSpeechTimer = null;
    this.sessionStartWaiter?.finish(
      new Error("The realtime voice session ended during setup."),
    );
    this.sessionStartWaiter = null;

    const desktopVoice = this.desktopVoice;
    const connectedAt = this.connectedAt;
    this.desktopVoice = null;
    this.connectedAt = null;

    await this.closeLiveSession();
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.channel = null;
    try {
      this.pc?.close();
    } catch {
      // Already closed.
    }
    this.pc = null;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream.release();
      this.localStream = null;
    }
    const audioLease = this.audioLease;
    this.audioLease = null;
    if (audioLease !== null) {
      try {
        await releaseRecordingAudioSession(audioLease);
      } catch {
        // The OS resets its audio session when the app leaves the foreground.
      }
    }
    if (desktopVoice && connectedAt !== null) {
      const durationMs = Math.max(0, Date.now() - connectedAt);
      try {
        await persistDesktopRealtimeVoiceTranscript(desktopVoice, {
          conversationId: this.options.conversationId,
          eventId: desktopVoiceTranscriptEventId(
            this.requestId,
            "assistant",
            "session-summary",
          ),
          timestamp: Date.now(),
          role: "assistant",
          text: [
            "Voice session",
            "",
            `Duration: ${formatVoiceSessionDuration(durationMs)}`,
          ].join("\n"),
          uiVisibility: "visible",
          voiceSession: { durationMs },
        });
      } catch (error) {
        console.debug(
          "[realtime-voice] Desktop voice summary persistence failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
