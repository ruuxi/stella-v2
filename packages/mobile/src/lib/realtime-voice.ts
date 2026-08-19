import { AudioModule } from "expo-audio";
import type {
  MediaStream,
  RTCPeerConnection as NativeRTCPeerConnection,
} from "react-native-webrtc";
import type { ChatMessage, MobileTask } from "../types";
import type { StoredPhoneAccess } from "./phone-access";
import { postJson } from "./http";
import {
  buildComputerVoiceInstructions,
  buildMobileRealtimeSessionUpdate,
  buildNormalChatVoiceInstructions,
  findVoiceActionCompletion,
  managedVoiceConversationId,
  mergeComputerVoiceTools,
  realtimeErrorMessage,
  type RealtimeVoiceActionDispatch,
  type RealtimeVoiceOrchestratorConfig,
  type RealtimeVoicePhase,
} from "./realtime-voice-protocol";
import {
  connectDesktopRealtimeVoice,
  executeDesktopRealtimeVoiceTool,
  persistDesktopRealtimeVoiceTranscript,
  type DesktopRealtimeVoice,
} from "./desktop-realtime-voice";
import { REALTIME_VOICE_AUDIO_MODE } from "./realtime-voice-audio";
import {
  acquireRecordingAudioSession,
  refreshRecordingAudioSession,
  releaseRecordingAudioSession,
  type RecordingAudioLease,
} from "./mobile-audio-session";

const OPENAI_REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 15_000;
const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_EXPIRY_SKEW_MS = 1_000;
const SESSION_UPDATE_TIMEOUT_MS = 10_000;
const SDP_NEGOTIATION_TIMEOUT_MS = 20_000;
const DISCONNECTED_GRACE_MS = 10_000;
const GOODBYE_DRAIN_FALLBACK_MS = 1_200;

type VoiceSessionToken = {
  voiceProvider?: "openai";
  transport?: "openai-webrtc";
  clientSecret?: unknown;
  expiresAt?: unknown;
  sessionId?: unknown;
  model?: unknown;
  voice?: unknown;
  stellaSessionId?: unknown;
  leaseExpiresAt?: unknown;
};

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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

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
 * One foreground mobile Realtime session. It mirrors the desktop's managed
 * OpenAI path but deliberately keeps the lifecycle bounded to the full-screen
 * surface: closing the surface closes the microphone, peer, and backend lease.
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
    clientSecret: string;
    stellaSessionId?: string;
    leaseExpiresAt?: number;
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
  private goodbyeTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private sdpAbortController: AbortController | null = null;
  private sessionUpdateWaiter: {
    eventId: string;
    finish: (error?: Error) => void;
  } | null = null;
  private handledToolCalls = new Set<string>();
  private handledUserTranscripts = new Set<string>();
  private persistedDesktopTranscripts = new Set<string>();
  private pendingActionRequestIds = new Set<string>();
  private queuedCompletionTexts: string[] = [];
  private responseActive = false;
  private responseRequested = false;
  private userTurnPendingResponse = false;
  private goodbyePending = false;
  private closeAfterNextSpokenReply = false;
  private userTranscriptBuffer = "";
  private assistantTranscriptBuffer = "";

  constructor(options: SessionOptions) {
    this.options = options;
  }

  /**
   * Feed settled text-chat results back into the live voice conversation.
   * This mirrors desktop local-chat sync so a Computer/Chat action can be
   * announced aloud when it genuinely finishes.
   */
  syncAssistantMessages(
    messages: ChatMessage[],
    tasks: readonly MobileTask[],
    chatBusy: boolean,
  ): void {
    if (this.options.execution !== "phone") return;
    if (chatBusy || !this.snapshot.isConnected || this.stopped) return;
    for (const requestId of this.pendingActionRequestIds) {
      const completion = findVoiceActionCompletion(messages, requestId, tasks);
      if (!completion) continue;
      this.pendingActionRequestIds.delete(requestId);
      this.queuedCompletionTexts.push(
        [
          completion.failed
            ? "The attached Stella chat failed to complete work requested during this voice session."
            : "The attached Stella chat completed work requested during this voice session.",
          completion.text.slice(0, 8_000),
          completion.failed
            ? "Tell the user briefly that it failed and what they can do next."
            : "Tell the user the result naturally and briefly.",
        ].join("\n"),
      );
    }
    this.flushResponseQueue();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.publish({ ...INITIAL_REALTIME_VOICE_SNAPSHOT });

    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
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
      const { mediaDevices, RTCPeerConnection } = await import(
        "react-native-webrtc"
      );
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

      let instructions: string;
      let tools: RealtimeVoiceOrchestratorConfig["tools"] = [];
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
        instructions = buildComputerVoiceInstructions(this.desktopVoice.config);
        tools = mergeComputerVoiceTools(this.desktopVoice.config.tools);
      } else {
        instructions = buildNormalChatVoiceInstructions(this.options.messages);
      }
      const managedConversationId = managedVoiceConversationId(
        this.options.conversationId,
      );
      const raw = (await postJson(
        "/api/voice/session",
        {
          ...(managedConversationId
            ? { conversationId: managedConversationId }
            : {}),
          instructions,
          ...(this.options.execution === "computer" ? { tools } : {}),
          voiceProvider: "openai",
        },
        { timeoutMs: 20_000 },
      )) as VoiceSessionToken;
      const clientSecret = asString(raw.clientSecret);
      const model = asString(raw.model);
      const voice = asString(raw.voice);
      if (!clientSecret || !model || !voice) {
        throw new Error(
          "Stella did not return a complete realtime voice session.",
        );
      }
      this.token = {
        clientSecret,
        model,
        voice,
        ...(typeof raw.stellaSessionId === "string"
          ? { stellaSessionId: raw.stellaSessionId }
          : {}),
        ...(typeof raw.leaseExpiresAt === "number"
          ? { leaseExpiresAt: raw.leaseExpiresAt }
          : {}),
      };
      if (this.stopped) {
        await this.reportLeaseTerminal(this.stopEvent);
        await this.releaseConnection();
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
      let answerResponse: Response;
      try {
        answerResponse = await fetch(OPENAI_REALTIME_SDP_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: localSdp,
          signal: sdpAbortController.signal,
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
      if (!answerResponse.ok) {
        throw new Error(
          `Realtime voice negotiation failed (${answerResponse.status}).`,
        );
      }
      await pc.setRemoteDescription({
        type: "answer",
        sdp: await answerResponse.text(),
      });
      await waitForDataChannelOpen(channel);
      if (this.stopped) return;

      // Normal mobile chat owns the turn lifecycle, so VAD commits and
      // transcribes speech without letting Realtime answer independently.
      // Computer voice instead receives the connected desktop's exact runtime
      // tool catalog and follows the same direct-tool loop as desktop voice.
      const sessionUpdateEventId = `${this.requestId}:session-update`;
      const sessionUpdated = this.waitForSessionUpdated(sessionUpdateEventId);
      this.send(
        buildMobileRealtimeSessionUpdate({
          eventId: sessionUpdateEventId,
          execution: this.options.execution,
          instructions,
          tools,
        }),
      );
      await sessionUpdated;
      if (this.stopped) return;
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
      const terminalReport = this.reportLeaseTerminal("lost");
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
      await this.releaseConnection();
      void terminalReport;
    }
  }

  async stop(event: "ended" | "lost" | "expired" = "ended"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopEvent = event;
    const terminalReport = this.reportLeaseTerminal(event);
    await this.releaseConnection();
    void terminalReport;
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
      case "session.updated":
        this.sessionUpdateWaiter?.finish();
        return;
      case "response.created":
        this.userTurnPendingResponse = false;
        this.responseActive = true;
        return;
      case "input_audio_buffer.speech_started":
        this.userTranscriptBuffer = "";
        this.userTurnPendingResponse = this.options.execution === "computer";
        this.publish({
          phase: this.snapshot.isAssistantSpeaking
            ? "assistant-speaking"
            : "user-speaking",
          isUserSpeaking: true,
          micLevel: 0.28,
        });
        return;
      case "input_audio_buffer.speech_stopped":
        this.publish({
          phase: this.snapshot.isAssistantSpeaking
            ? "assistant-speaking"
            : "listening",
          isUserSpeaking: false,
          micLevel: 0,
        });
        return;
      case "output_audio_buffer.started":
      case "output_audio.started":
        // iOS can reapply WebRTC's receiver route when remote audio starts.
        // Correct it at the exact playback boundary as well as during setup.
        void this.ensureLoudspeakerRoute();
        if (this.goodbyeTimer) clearTimeout(this.goodbyeTimer);
        this.goodbyeTimer = null;
        this.assistantTranscriptBuffer = "";
        this.publish({
          phase: "assistant-speaking",
          isAssistantSpeaking: true,
          outputLevel: 0.36,
        });
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
      case "output_audio.done":
        this.publish({
          phase: this.snapshot.isUserSpeaking ? "user-speaking" : "listening",
          isAssistantSpeaking: false,
          outputLevel: 0,
        });
        if (this.goodbyePending || this.closeAfterNextSpokenReply) {
          this.closeAfterNextSpokenReply = false;
          this.goodbyePending = true;
          this.finishGoodbye();
        } else this.flushResponseQueue();
        return;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = asString(event.delta);
        this.userTranscriptBuffer += delta;
        if (delta) this.publish({ transcript: this.userTranscriptBuffer });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript =
          asString(event.transcript).trim() || this.userTranscriptBuffer.trim();
        this.userTranscriptBuffer = transcript;
        if (transcript) {
          this.publish({ transcript });
          if (this.options.execution === "phone") {
            this.userTurnPendingResponse = false;
            void this.dispatchNormalChatTranscript(event, transcript);
          } else {
            void this.persistComputerTranscript(event, "user", transcript);
          }
        }
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        this.responseActive = true;
        const delta = asString(event.delta);
        this.assistantTranscriptBuffer += delta;
        if (delta) this.publish({ transcript: this.assistantTranscriptBuffer });
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const transcript =
          asString(event.transcript).trim() ||
          this.assistantTranscriptBuffer.trim();
        this.assistantTranscriptBuffer = transcript;
        if (transcript) {
          this.publish({ transcript });
          if (this.options.execution === "computer") {
            void this.persistComputerTranscript(event, "assistant", transcript);
          }
        }
        return;
      }
      case "response.function_call_arguments.done":
        void this.handleFunctionCall({
          name: event.name,
          call_id: event.call_id,
          arguments: event.arguments,
        });
        return;
      case "response.output_item.done": {
        const item = asRecord(event.item);
        if (item?.type === "function_call") {
          void this.handleFunctionCall(item);
        }
        return;
      }
      case "response.done": {
        const response = asRecord(event.response);
        if (response) void this.reportUsage(response);
        this.responseActive = false;
        this.flushResponseQueue();
        return;
      }
      case "error":
        if (this.sessionUpdateWaiter) {
          const error = asRecord(event.error);
          const rejectedEventId = asString(error?.event_id);
          if (
            rejectedEventId &&
            rejectedEventId !== this.sessionUpdateWaiter.eventId
          ) {
            return;
          }
          this.sessionUpdateWaiter.finish(
            new Error(realtimeErrorMessage(event)),
          );
          return;
        }
        // Realtime emits recoverable protocol errors too (for example, a
        // response.create arriving while another response is finishing).
        // The peer/data-channel lifecycle remains the authoritative signal for
        // a lost session.
        console.debug(
          "[realtime-voice] Provider event:",
          realtimeErrorMessage(event),
        );
        return;
      default:
        return;
    }
  }

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = asString(item.name);
    const callId = asString(item.call_id);
    if (!name || !callId || this.handledToolCalls.has(callId)) return;
    this.handledToolCalls.add(callId);

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(asString(item.arguments) || "{}") as Record<
        string,
        unknown
      >;
    } catch {
      // An invalid argument payload falls back to the latest final transcript.
    }

    if (name === "no_response") {
      this.sendToolOutput(callId, "ok", false);
      return;
    }
    if (name === "goodbye" || name === "close") {
      this.sendToolOutput(callId, "ok", false);
      this.goodbyePending = true;
      if (!this.snapshot.isAssistantSpeaking) {
        this.goodbyeTimer = setTimeout(
          () => this.finishGoodbye(),
          GOODBYE_DRAIN_FALLBACK_MS,
        );
      }
      return;
    }

    if (this.options.execution !== "computer" || !this.desktopVoice) {
      this.sendToolOutput(
        callId,
        "The connected computer's Stella tools are not available.",
        true,
      );
      return;
    }

    let output: string;
    try {
      const result = await executeDesktopRealtimeVoiceTool(
        this.desktopVoice.bridge,
        {
          requestId: this.requestId,
          conversationId: this.options.conversationId,
          callId,
          name,
          args,
        },
      );
      output =
        result.output || (result.error ? `Error: ${result.error}` : "ok");
    } catch (error) {
      output = `Error: ${
        error instanceof Error
          ? error.message
          : "The connected computer could not run that tool."
      }`;
    }
    this.sendToolOutput(callId, output, true);
  }

  private async dispatchNormalChatTranscript(
    event: Record<string, unknown>,
    transcript: string,
  ) {
    const itemId = asString(event.item_id);
    if (itemId) {
      if (this.handledUserTranscripts.has(itemId)) return;
      this.handledUserTranscripts.add(itemId);
    }
    const shouldClose = clearlyEndsConversation(transcript);
    let dispatch: RealtimeVoiceActionDispatch = null;
    try {
      dispatch = await this.options.onPerformAction(transcript);
    } catch {
      dispatch = null;
    }
    if (this.stopped) return;
    if (dispatch) {
      this.pendingActionRequestIds.add(dispatch.userMessageId);
      if (shouldClose) this.closeAfterNextSpokenReply = true;
      return;
    }
    this.queuedCompletionTexts.push(
      "The attached Stella chat could not accept that message. Ask the user to try again.",
    );
    if (shouldClose) this.closeAfterNextSpokenReply = true;
    this.flushResponseQueue();
  }

  private async persistComputerTranscript(
    event: Record<string, unknown>,
    role: "user" | "assistant",
    transcript: string,
  ) {
    if (!this.desktopVoice) return;
    const eventItemId = asString(event.item_id) || asString(event.response_id);
    const key = eventItemId ? `${role}:${eventItemId}:${transcript}` : "";
    if (key) {
      if (this.persistedDesktopTranscripts.has(key)) return;
      this.persistedDesktopTranscripts.add(key);
    }
    try {
      await persistDesktopRealtimeVoiceTranscript(this.desktopVoice.bridge, {
        conversationId: this.options.conversationId,
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

  private sendToolOutput(
    callId: string,
    output: string,
    createResponse: boolean,
  ) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    if (createResponse) this.requestResponse();
  }

  private requestResponse() {
    if (
      this.responseActive ||
      this.snapshot.isAssistantSpeaking ||
      this.snapshot.isUserSpeaking ||
      this.userTurnPendingResponse
    ) {
      this.responseRequested = true;
      return;
    }
    this.responseActive = true;
    this.send(
      this.options.execution === "phone"
        ? {
            type: "response.create",
            response: {
              tools: [],
              tool_choice: "none",
              instructions:
                "Speak the completed attached-chat answer faithfully and naturally. Do not add new claims or call tools.",
            },
          }
        : { type: "response.create" },
    );
  }

  private flushResponseQueue() {
    if (
      this.responseActive ||
      this.snapshot.isAssistantSpeaking ||
      this.snapshot.isUserSpeaking ||
      this.userTurnPendingResponse ||
      this.stopped
    ) {
      return;
    }
    const completions = this.queuedCompletionTexts.splice(0);
    for (const text of completions) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: ["<system-reminder>", text, "</system-reminder>"].join(
                "\n",
              ),
            },
          ],
        },
      });
    }
    if (!completions.length && !this.responseRequested) return;
    this.responseRequested = false;
    this.requestResponse();
  }

  private waitForSessionUpdated(eventId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.sessionUpdateWaiter?.finish === finish) {
          this.sessionUpdateWaiter = null;
        }
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error("Realtime voice configuration took too long to apply."),
          ),
        SESSION_UPDATE_TIMEOUT_MS,
      );
      this.sessionUpdateWaiter = { eventId, finish };
    });
  }

  private async ensureLoudspeakerRoute(): Promise<void> {
    const lease = this.audioLease;
    if (lease === null) return;
    try {
      await refreshRecordingAudioSession(lease, REALTIME_VOICE_AUDIO_MODE);
    } catch (error) {
      // A transient OS route failure should not tear down an otherwise healthy
      // Realtime session; the next assistant response retries the route.
      console.debug(
        "[realtime-voice] Could not route output through the loudspeaker:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private finishGoodbye() {
    if (!this.goodbyePending || this.stopped) return;
    this.goodbyePending = false;
    if (this.goodbyeTimer) clearTimeout(this.goodbyeTimer);
    this.goodbyeTimer = null;
    this.options.onEndRequested();
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
    if (!this.token?.stellaSessionId) return;
    void this.reportLeaseEvent("heartbeat");
    this.heartbeatTimer = setInterval(() => {
      void this.reportLeaseEvent("heartbeat");
    }, LEASE_HEARTBEAT_MS);

    if (this.token.leaseExpiresAt) {
      const delay = Math.max(
        0,
        this.token.leaseExpiresAt - Date.now() - LEASE_EXPIRY_SKEW_MS,
      );
      this.leaseExpiryTimer = setTimeout(() => {
        if (this.stopped) return;
        this.publish({
          phase: "error",
          isConnected: false,
          error: "This voice session expired. Start a new one to keep talking.",
        });
        void this.stop("expired");
      }, delay);
    }
  }

  private async reportUsage(response: Record<string, unknown>) {
    const responseId = asString(response.id);
    const usage = asRecord(response.usage);
    if (!responseId || !usage || !this.token) return;
    try {
      await postJson("/api/voice/usage", {
        responseId,
        model: this.token.model,
        ...(this.token.stellaSessionId
          ? { stellaSessionId: this.token.stellaSessionId }
          : {}),
        conversationId: this.options.conversationId,
        usage,
      });
    } catch {
      // Billing telemetry is best-effort from the client; the backend lease
      // still prevents another managed session from hiding unreported usage.
    }
  }

  private async reportLeaseEvent(
    event: "heartbeat" | "ended" | "expired" | "lost",
  ) {
    const stellaSessionId = this.token?.stellaSessionId;
    if (!stellaSessionId) return;
    try {
      await postJson("/api/voice/lease", { stellaSessionId, event });
    } catch {
      // A terminal retry is not useful once the foreground surface is gone.
    }
  }

  private async reportLeaseTerminal(event: "ended" | "expired" | "lost") {
    if (this.leaseTerminalReported) return;
    if (!this.token?.stellaSessionId) return;
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
    const terminalReport = this.reportLeaseTerminal("lost");
    await this.releaseConnection();
    void terminalReport;
  }

  private async releaseConnection() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.leaseExpiryTimer) clearTimeout(this.leaseExpiryTimer);
    if (this.goodbyeTimer) clearTimeout(this.goodbyeTimer);
    this.clearDisconnectedTimer();
    this.sdpAbortController?.abort();
    this.sdpAbortController = null;
    this.heartbeatTimer = null;
    this.leaseExpiryTimer = null;
    this.goodbyeTimer = null;
    this.sessionUpdateWaiter?.finish(
      new Error("The realtime voice session ended during setup."),
    );
    this.sessionUpdateWaiter = null;

    const desktopVoice = this.desktopVoice;
    const connectedAt = this.connectedAt;
    this.desktopVoice = null;
    this.connectedAt = null;

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
        await persistDesktopRealtimeVoiceTranscript(desktopVoice.bridge, {
          conversationId: this.options.conversationId,
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
