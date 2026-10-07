/**
 * RealtimeVoiceSession — transport-agnostic session orchestration for
 * Stella's live voice call.
 *
 * Since the move to GPT-Live client delegation this is a two-brain session:
 * the voice model owns the spoken conversation full-duplex and owns nothing
 * else. It has no tools and no system prompt. Everything that requires
 * thinking, memory, files, apps or subagents is delegated to Stella's text
 * orchestrator and handed back as commentary.
 *
 * Responsibilities:
 *   - Lifecycle / state machine (idle → connecting → connected → …).
 *   - Server event routing: transcripts (fragments, accumulated into turns),
 *     delegation requests, append acks.
 *   - Delegation to the orchestrator and the appends that answer it.
 *   - Mid-call updates from the conversation stream (cloud or local), so a
 *     call hears about agent results and new text turns while it is open.
 *   - Echo guard: watches the mic and assistant-output analysers and applies a
 *     soft input mute when our own voice is leaking into the microphone.
 *   - Lease heartbeat for the Stella-managed path. GPT-Live is billed per
 *     second of session duration, so there is no per-response usage report —
 *     the orchestrator's model spend is metered through the normal agent path.
 *   - Goodbye-phrase detection that ends the live turn while leaving the warm
 *     session attached for the next wake word.
 *
 * What it deliberately does NOT do:
 *   - Open RTCPeerConnection / WebSocket, capture mic audio, or schedule
 *     playback. That's the transport.
 *   - Run tools. There are none here any more.
 */

import { z } from "zod";
import type {
  VoiceHistoryMessage,
  VoiceHistoryRole,
  VoiceLease,
  VoiceLeaseEvent,
} from "@stella/contracts/backend/voice";
import {
  VOICE_HISTORY_MAX_CHARS,
  VOICE_HISTORY_MAX_MESSAGES,
  VOICE_INSTRUCTIONS_MAX_CHARS,
} from "@stella/contracts/backend/voice";
import { backendClient } from "@/platform/backend/backend-client";
import { getVoiceSessionPromptConfig } from "@/prompts";
import type { RuntimeVoiceHistoryItem } from "@stella/contracts/protocol";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";
import {
  createConversationUpdateFeed,
  type ConversationUpdate,
  type ConversationUpdateFeed,
} from "@/features/voice/services/conversation-updates";
import { DelegationController } from "./delegation-controller";
import { SessionAppendChannel } from "./session-append-channel";
import {
  TranscriptAccumulator,
  type CompletedTranscriptTurn,
} from "./transcript-accumulator";
import { createRealtimeTransport } from "./providers/provider-registry";
import { requireVoiceSessionAuthority } from "./providers/types";
import type {
  RealtimeProviderKey,
  VoiceSessionAuthority,
  VoiceSessionToken,
} from "./providers/types";
import type { RealtimeTransport } from "./transports/types";

const eventRecordSchema = z.record(z.string(), z.unknown());

const isEventRecord = (value: unknown): value is Record<string, unknown> =>
  eventRecordSchema.safeParse(value).success;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disconnecting";

export type VoiceSessionEvent =
  | { type: "state-change"; state: VoiceSessionState; error?: string }
  | { type: "user-transcript"; text: string; isFinal: boolean }
  | { type: "assistant-transcript"; text: string; isFinal: boolean }
  | { type: "tool-start"; name: string; callId: string }
  | { type: "tool-end"; name: string; callId: string; result: string }
  | { type: "speaking-start" }
  | { type: "speaking-end" }
  | { type: "user-speaking-start" }
  | { type: "user-speaking-end" };

type VoiceSessionListener = (event: VoiceSessionEvent) => void;

type VoiceRuntimeState = {
  activeSession: { disconnect: () => Promise<void> } | null;
};

const VOICE_RUNTIME_STATE_KEY = "__stellaRealtimeVoiceRuntimeState";

const getVoiceRuntimeState = (): VoiceRuntimeState => {
  const root = globalThis as typeof globalThis & {
    [VOICE_RUNTIME_STATE_KEY]?: VoiceRuntimeState;
  };
  if (!root[VOICE_RUNTIME_STATE_KEY]) {
    root[VOICE_RUNTIME_STATE_KEY] = {
      activeSession: null,
    };
  }
  return root[VOICE_RUNTIME_STATE_KEY];
};

// ---------------------------------------------------------------------------
// Echo guard tuning
// ---------------------------------------------------------------------------

const ECHO_GUARD_SAMPLE_MS = 40;
const ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD = 0.02;
const ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL = 0.05;
const ECHO_GUARD_BARGE_IN_MARGIN = 0.02;
const ECHO_GUARD_BARGE_IN_RATIO = 0.85;
const ECHO_GUARD_RELEASE_MS = 180;
const STELLA_VOICE_LEASE_HEARTBEAT_MS = 2_000;
const STELLA_VOICE_LEASE_REQUEST_TIMEOUT_MS = 1_500;
const STELLA_VOICE_AUTHORITY_MAX_LOCAL_LIFETIME_MS = 10_000;
const STELLA_VOICE_AUTHORITY_EXPIRY_SKEW_MS = 1_000;
/** How many of our own utterances to remember for update de-duplication. */
const SPOKEN_MEMORY_SIZE = 24;

type VoiceEchoMetrics = {
  assistantSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
  recentOutputActiveUntil?: number;
  now?: number;
};

type VoiceLeaseRequest = { leaseId: string; event: VoiceLeaseEvent };

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The voice backend took too long to answer.")),
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

/**
 * Lightweight goodbye matcher. We only fire on simple terminal farewells —
 * "bye", "goodbye", "bye stella" — said as a standalone utterance. Anything
 * embedded in a longer sentence ("…by Tuesday", "good morning") is left alone
 * so the user can't accidentally hang up mid-sentence.
 */
const GOODBYE_PHRASES = [
  /^(?:hey\s+|ok(?:ay)?\s+|alright\s+)?(?:bye|goodbye|good\s*bye)(?:\s+stella)?[\s.!?,]*$/i,
  /^(?:bye|goodbye)\s+(?:now|then|for\s+now)[\s.!?,]*$/i,
  /^(?:thanks?|thank\s+you)[,\s]+(?:bye|goodbye)[\s.!?,]*$/i,
];

function matchesGoodbye(transcript: string): boolean {
  const trimmed = transcript.trim();
  if (!trimmed) return false;
  return GOODBYE_PHRASES.some((re) => re.test(trimmed));
}

function shouldGateVoiceInputForEcho({
  assistantSpeaking,
  micLevel,
  outputLevel,
  recentOutputActiveUntil = 0,
  now = Date.now(),
}: VoiceEchoMetrics): boolean {
  const assistantAudioActive =
    assistantSpeaking || recentOutputActiveUntil > now;
  if (!assistantAudioActive || outputLevel < ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD) {
    return false;
  }

  const userLikelyBargingIn =
    micLevel >= ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL &&
    micLevel >=
      outputLevel * ECHO_GUARD_BARGE_IN_RATIO + ECHO_GUARD_BARGE_IN_MARGIN;

  return !userLikelyBargingIn;
}

// ---------------------------------------------------------------------------
// Startup history
// ---------------------------------------------------------------------------

const HISTORY_ROLE_BY_RUNTIME_ROLE: Record<string, VoiceHistoryRole> = {
  user: "user",
  assistant: "assistant",
  toolResult: "developer",
  runtimeInternal: "developer",
};

/**
 * GPT-Live takes startup history as a bounded list of single-part messages.
 * It is newest-biased on purpose: when the budget runs out the oldest turns
 * are the ones the call can afford to open without.
 */
export const buildVoiceStartupHistory = (
  history: RuntimeVoiceHistoryItem[] | undefined,
  limits: { maxMessages: number; maxChars: number } = {
    maxMessages: VOICE_HISTORY_MAX_MESSAGES,
    maxChars: VOICE_HISTORY_MAX_CHARS,
  },
): VoiceHistoryMessage[] => {
  const selected: VoiceHistoryMessage[] = [];
  let chars = 0;
  for (let index = (history?.length ?? 0) - 1; index >= 0; index -= 1) {
    const item = history?.[index];
    if (!item) continue;
    const role = HISTORY_ROLE_BY_RUNTIME_ROLE[item.role];
    const text = item.content.trim();
    if (!role || !text) continue;
    if (selected.length >= limits.maxMessages) break;
    if (chars + text.length > limits.maxChars) {
      if (selected.length > 0) break;
      selected.push({ role, text: text.slice(0, limits.maxChars) });
      break;
    }
    chars += text.length;
    selected.push({ role, text });
  }
  return selected.reverse();
};

/**
 * The spoken-conversation brief. Short by construction: the orchestrator
 * keeps Stella's real system prompt, and this model only needs to know how to
 * talk and when to hand off. The assertion guards the contract ceiling for a
 * locally edited prompt rather than truncating mid-sentence.
 */
const buildVoiceSessionInstructions = (): string => {
  const instructions = getVoiceSessionPromptConfig().basePrompt.trim();
  if (instructions.length <= VOICE_INSTRUCTIONS_MAX_CHARS) {
    return instructions;
  }
  throw new Error(
    `The voice prompt is ${instructions.length} characters, over the ${VOICE_INSTRUCTIONS_MAX_CHARS} GPT-Live accepts. Shorten it in Prompts.`,
  );
};

const normalizeSpoken = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private transport: RealtimeTransport | null = null;
  private sessionToken: VoiceSessionToken | null = null;
  private sessionProvider: RealtimeProviderKey = "stella";

  private destroyed = false;
  private inputActive = false;
  private assistantOutputActive = false;
  private userSpeakingEmitted = false;
  private recentOutputActiveUntil = 0;
  private softInputMuted = false;
  private echoGuardTimer: ReturnType<typeof setInterval> | null = null;
  private inputEnergyBuffer: Uint8Array | null = null;
  private outputEnergyBuffer: Uint8Array | null = null;

  private readonly appends: SessionAppendChannel;
  private readonly transcript: TranscriptAccumulator;
  private delegation: DelegationController | null = null;
  private updateFeed: ConversationUpdateFeed | null = null;
  private readonly spokenMemory: string[] = [];
  private readonly deliveredUpdateIds = new Set<string>();

  private leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTerminalReported = false;
  private leaseReportingGeneration = 0;
  private leaseHeartbeatInFlight = false;
  private authorityTerminationPromise: Promise<void> | null = null;
  private authorityTerminationError: string | null = null;
  private authorityLocalExpiresAt: number | null = null;

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;

  constructor() {
    this.appends = new SessionAppendChannel((event) => this.sendEvent(event));
    this.transcript = new TranscriptAccumulator({
      onPartial: (role, text) => {
        this.emit({
          type: role === "user" ? "user-transcript" : "assistant-transcript",
          text,
          isFinal: false,
        });
      },
      onTurn: (turn) => this.handleCompletedTurn(turn),
    });
  }

  get state(): VoiceSessionState {
    return this._state;
  }

  setConversationId(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Toggle whether mic audio is actively sent to the provider. The session
   * stays connected; transport-level capture is suspended while inactive.
   */
  setInputActive(active: boolean) {
    this.inputActive = active;
    void this.transport?.setMicEnabled(active).catch((err) => {
      console.debug(
        "[realtime-voice] Failed to sync microphone state:",
        (err as Error).message,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Event emitter
  // ---------------------------------------------------------------------------

  on(listener: VoiceSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceSessionEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.debug(
          "[realtime-voice] Listener error:",
          (err as Error).message,
        );
      }
    }
  }

  private setState(state: VoiceSessionState, error?: string) {
    this._state = state;
    this.emit({ type: "state-change", state, error });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async connect(conversationId: string): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      const orchestratorConfig = await window.electronAPI?.voice
        .getOrchestratorConfig?.({ conversationId })
        .catch((err) => {
          console.debug(
            "[realtime-voice] Failed to load orchestrator history:",
            (err as Error).message,
          );
          return null;
        });
      const instructions = buildVoiceSessionInstructions();
      const history = buildVoiceStartupHistory(orchestratorConfig?.history);
      if (this.destroyed) return;

      const { transport, token, providerKey } = await createRealtimeTransport({
        conversationId,
        instructions,
        history,
      });
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        return;
      }

      this.transport = transport;
      this.sessionToken = token;
      this.sessionProvider = providerKey;
      if (providerKey === "stella") {
        Object.assign(token, requireVoiceSessionAuthority(token));
        this.startLeaseReporting();
        if (this.destroyed) {
          throw new Error(
            this.authorityTerminationError ??
              "Realtime voice lease ended while connecting",
          );
        }
      }

      this.startDelegation();
      await this.startConversationUpdates(conversationId);
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        throw new Error(
          this.authorityTerminationError ??
            "Realtime voice lease ended while connecting",
        );
      }

      await transport.connect({
        onEvent: (event) => this.handleServerEvent(event),
        onClose: (reason) => {
          if (this._state === "connected" || this._state === "connecting") {
            const terminalRequest = this.claimTerminalLeaseRequest("lost");
            const transportClose = this.disconnectTransportImmediately();
            const finishClosure = this.finishVoiceClosure(
              terminalRequest,
              transportClose,
            );
            this.cleanupAfterConnectionLoss();
            this.setState("error", reason || "Connection lost");
            void finishClosure;
          }
        },
      });
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        throw new Error(
          this.authorityTerminationError ??
            "Realtime voice lease ended while connecting",
        );
      }

      await transport.setMicEnabled(this.inputActive);
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        throw new Error(
          this.authorityTerminationError ??
            "Realtime voice lease ended while connecting",
        );
      }

      this.updateFeed?.start();
      getVoiceRuntimeState().activeSession = this;
      this.setState("connected");
    } catch (err) {
      if (this.destroyed) {
        if (this.authorityTerminationError) {
          throw new Error(this.authorityTerminationError);
        }
        return;
      }
      const terminalRequest = this.claimTerminalLeaseRequest("lost");
      const transportClose = this.disconnectTransportImmediately();
      await this.finishVoiceClosure(terminalRequest, transportClose);
      this.sessionToken = null;
      this.stopDelegation();
      this.stopConversationUpdates();
      const runtime = getVoiceRuntimeState();
      if (runtime.activeSession === this) {
        runtime.activeSession = null;
      }
      this.setState("error", (err as Error).message);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._state === "idle" || this._state === "disconnecting") return;
    this.destroyed = true;
    const runtime = getVoiceRuntimeState();
    if (runtime.activeSession === this) {
      runtime.activeSession = null;
    }
    this.setState("disconnecting");
    await this.tearDown();
    this.setState("idle");
  }

  /** Get the mic input analyser node for visualization. */
  getAnalyser(): AnalyserNode | null {
    return this.transport?.getMicAnalyser() ?? null;
  }

  /** Get the output (assistant voice) analyser node for visualization. */
  getOutputAnalyser(): AnalyserNode | null {
    return this.transport?.getOutputAnalyser() ?? null;
  }

  // ---------------------------------------------------------------------------
  // Echo guard
  // ---------------------------------------------------------------------------

  private getAnalyserEnergy(
    analyser: AnalyserNode | null,
    kind: "input" | "output",
  ): number {
    const buffer =
      kind === "input" ? this.inputEnergyBuffer : this.outputEnergyBuffer;
    const result = computeAnalyserEnergy(analyser, buffer);
    if (kind === "input") {
      this.inputEnergyBuffer = result.buffer;
    } else {
      this.outputEnergyBuffer = result.buffer;
    }
    return result.energy;
  }

  private startEchoGuardMonitor() {
    if (this.echoGuardTimer) return;
    this.echoGuardTimer = setInterval(() => {
      this.syncEchoGuard();
      // Echo guard only matters while assistant audio is (or was just)
      // playing — that's the only time the mic could be picking up our own
      // speech. Past the release window the monitor has nothing useful to do.
      if (
        !this.assistantOutputActive &&
        this.recentOutputActiveUntil <= Date.now()
      ) {
        if (this.softInputMuted) this.applySoftInputMute(false);
        this.stopEchoGuardMonitor();
      }
    }, ECHO_GUARD_SAMPLE_MS);
  }

  private stopEchoGuardMonitor() {
    if (this.echoGuardTimer) {
      clearInterval(this.echoGuardTimer);
      this.echoGuardTimer = null;
    }
  }

  private applySoftInputMute(shouldMute: boolean) {
    this.softInputMuted = shouldMute;
    this.transport?.applySoftInputMute(shouldMute);
  }

  private syncEchoGuard() {
    const shouldMute =
      this.inputActive &&
      shouldGateVoiceInputForEcho({
        assistantSpeaking: this.assistantOutputActive,
        micLevel: this.getAnalyserEnergy(
          this.transport?.getMicAnalyser() ?? null,
          "input",
        ),
        outputLevel: this.getAnalyserEnergy(
          this.transport?.getOutputAnalyser() ?? null,
          "output",
        ),
        recentOutputActiveUntil: this.recentOutputActiveUntil,
      });

    if (this.softInputMuted !== shouldMute) {
      this.applySoftInputMute(shouldMute);
    }
  }

  // ---------------------------------------------------------------------------
  // Delegation + mid-call updates
  // ---------------------------------------------------------------------------

  private sendEvent(event: Record<string, unknown>) {
    this.transport?.send(event);
  }

  private startDelegation() {
    this.delegation = new DelegationController({
      appends: this.appends,
      transcript: this.transcript,
      getConversationId: () => this.conversationId,
      isInputActive: () => this.inputActive,
      runOrchestrator: async ({ requestId, conversationId, message }) => {
        const api = window.electronAPI?.voice;
        if (!api?.orchestratorChat) {
          throw new Error("Stella's backend is not available on this device.");
        }
        return await api.orchestratorChat({
          requestId,
          conversationId,
          message,
        });
      },
      subscribeActivity: (handler) =>
        window.electronAPI?.voice.onOrchestratorActivity?.(handler) ??
        (() => undefined),
      events: {
        onToolStart: (name, callId) =>
          this.emit({ type: "tool-start", name, callId }),
        onToolEnd: (name, callId, result) =>
          this.emit({ type: "tool-end", name, callId, result }),
      },
    });
  }

  private stopDelegation() {
    this.delegation?.dispose();
    this.delegation = null;
    this.appends.dispose();
  }

  /**
   * Attach the conversation stream and adopt its current contents as already
   * known, so opening a call does not narrate the history the startup
   * `history` field already carried.
   */
  private async startConversationUpdates(conversationId: string) {
    const feed = createConversationUpdateFeed({
      conversationId,
      onUpdate: (update) => this.handleConversationUpdate(update),
    });
    this.updateFeed = feed;
    await feed.prime().catch((err) => {
      console.debug(
        "[realtime-voice] Failed to prime conversation updates:",
        (err as Error).message,
      );
    });
  }

  private stopConversationUpdates() {
    this.updateFeed?.stop();
    this.updateFeed = null;
    this.deliveredUpdateIds.clear();
  }

  private handleConversationUpdate(update: ConversationUpdate) {
    if (this.destroyed || this._state !== "connected") return;
    if (this.deliveredUpdateIds.has(update.id)) return;
    this.deliveredUpdateIds.add(update.id);

    // Never tell the model its own words back: the call's commentary and its
    // own speech are already in the session.
    if (this.wasAlreadyHeard(update.text)) return;

    if (update.kind === "say" && this.inputActive) {
      this.appends.append(
        "commentary",
        update.text,
        this.delegation?.activeDelegationId ?? null,
      );
      return;
    }
    this.appends.append("thinking", update.text, null);
  }

  private rememberSpoken(text: string) {
    const normalized = normalizeSpoken(text);
    if (!normalized) return;
    this.spokenMemory.push(normalized);
    if (this.spokenMemory.length > SPOKEN_MEMORY_SIZE) {
      this.spokenMemory.splice(0, this.spokenMemory.length - SPOKEN_MEMORY_SIZE);
    }
  }

  private wasAlreadyHeard(text: string): boolean {
    const normalized = normalizeSpoken(text);
    if (!normalized) return false;
    return this.spokenMemory.some(
      (remembered) =>
        remembered.length > 24 &&
        (normalized.includes(remembered) || remembered.includes(normalized)),
    );
  }

  // ---------------------------------------------------------------------------
  // Lease reporting
  // ---------------------------------------------------------------------------

  private buildLeaseRequest(event: VoiceLeaseEvent): VoiceLeaseRequest | null {
    if (this.sessionProvider !== "stella" || !this.sessionToken) return null;
    try {
      const { leaseId } = requireVoiceSessionAuthority(this.sessionToken);
      return { leaseId, event };
    } catch {
      return null;
    }
  }

  private async postLeaseRequest(
    request: VoiceLeaseRequest,
  ): Promise<VoiceLease> {
    return await withTimeout(
      backendClient.call("voice.lease", request),
      STELLA_VOICE_LEASE_REQUEST_TIMEOUT_MS,
    );
  }

  private updateLocalAuthorityExpiry(leaseExpiresAt: number) {
    const now = Date.now();
    const remainingMs = Math.min(
      STELLA_VOICE_AUTHORITY_MAX_LOCAL_LIFETIME_MS,
      leaseExpiresAt - now,
    );
    this.authorityLocalExpiresAt =
      now + Math.max(0, remainingMs - STELLA_VOICE_AUTHORITY_EXPIRY_SKEW_MS);
  }

  private claimTerminalLeaseRequest(
    event: Exclude<VoiceLeaseEvent, "heartbeat">,
  ): VoiceLeaseRequest | null {
    if (this.leaseTerminalReported) return null;
    const request = this.buildLeaseRequest(event);
    if (!request) return null;
    this.leaseTerminalReported = true;
    return request;
  }

  /** Send a terminal event after the transport is closed. */
  private async reportClosedLeaseRequest(request: VoiceLeaseRequest) {
    try {
      await this.postLeaseRequest(request);
    } catch (err) {
      console.debug(
        "[realtime-voice] Failed to report voice lease event:",
        (err as Error).message,
      );
    }
  }

  /** Invoke the transport close before doing any terminal bookkeeping. */
  private disconnectTransportImmediately(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (!transport) return Promise.resolve();
    try {
      return Promise.resolve(transport.disconnect()).catch((err) => {
        console.debug(
          "[realtime-voice] Transport disconnect failed:",
          (err as Error).message,
        );
      });
    } catch (err) {
      console.debug(
        "[realtime-voice] Transport disconnect failed:",
        (err as Error).message,
      );
      return Promise.resolve();
    }
  }

  private async finishVoiceClosure(
    request: VoiceLeaseRequest | null,
    transportClose: Promise<void>,
  ) {
    await transportClose;
    if (request) await this.reportClosedLeaseRequest(request);
  }

  private startLeaseReporting() {
    if (this.sessionProvider !== "stella" || !this.sessionToken) return;

    // `connect` already validates this before opening the transport. Keep the
    // guard so a future call-site cannot start an unleased managed session.
    let authority: VoiceSessionAuthority;
    try {
      authority = requireVoiceSessionAuthority(this.sessionToken);
    } catch {
      void this.terminateForAuthority(null, "Realtime voice lease was invalid");
      return;
    }

    this.stopLeaseReporting();
    this.leaseTerminalReported = false;
    this.leaseHeartbeatInFlight = false;
    this.authorityTerminationPromise = null;
    this.authorityTerminationError = null;
    this.updateLocalAuthorityExpiry(authority.leaseExpiresAt);
    const generation = this.leaseReportingGeneration;
    if (!this.scheduleLeaseExpiry(generation)) return;

    void this.pollLeaseAuthority(generation);
    this.leaseHeartbeatTimer = setInterval(() => {
      void this.pollLeaseAuthority(generation);
    }, STELLA_VOICE_LEASE_HEARTBEAT_MS);
  }

  private stopLeaseReporting() {
    this.leaseReportingGeneration += 1;
    if (this.leaseHeartbeatTimer) {
      clearInterval(this.leaseHeartbeatTimer);
      this.leaseHeartbeatTimer = null;
    }
    if (this.leaseExpiryTimer) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
  }

  private scheduleLeaseExpiry(generation: number): boolean {
    if (this.leaseExpiryTimer) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
    if (
      generation !== this.leaseReportingGeneration ||
      this.leaseTerminalReported ||
      !this.sessionToken
    ) {
      return false;
    }

    const expiresAt = this.authorityLocalExpiresAt;
    if (typeof expiresAt !== "number") {
      void this.terminateForAuthority(null, "Realtime voice lease was invalid");
      return false;
    }
    const delayMs = expiresAt - Date.now();
    if (delayMs <= 0) {
      void this.terminateForAuthority("expired", "Realtime voice lease expired");
      return false;
    }

    this.leaseExpiryTimer = setTimeout(() => {
      if (
        generation !== this.leaseReportingGeneration ||
        this.leaseTerminalReported
      ) {
        return;
      }
      void this.terminateForAuthority(
        "expired",
        "Realtime voice lease expired",
      );
    }, delayMs);
    return true;
  }

  private async pollLeaseAuthority(generation: number) {
    if (
      generation !== this.leaseReportingGeneration ||
      this.leaseTerminalReported ||
      this.leaseHeartbeatInFlight
    ) {
      return;
    }
    const request = this.buildLeaseRequest("heartbeat");
    if (!request) {
      void this.terminateForAuthority(null, "Realtime voice lease was invalid");
      return;
    }

    this.leaseHeartbeatInFlight = true;
    try {
      const response = await this.postLeaseRequest(request);
      if (
        generation !== this.leaseReportingGeneration ||
        this.leaseTerminalReported
      ) {
        return;
      }

      if (response.directive === "closed" || response.leaseExpiresAt === null) {
        // The server already closed the lease: nothing left to report.
        this.leaseTerminalReported = true;
        void this.terminateForAuthority(
          null,
          response.reason?.trim() || "Realtime voice session was closed",
        );
        return;
      }

      const previousExpiry = this.authorityLocalExpiresAt;
      if (typeof previousExpiry !== "number" || Date.now() >= previousExpiry) {
        void this.terminateForAuthority(
          "expired",
          "Realtime voice lease expired",
        );
        return;
      }
      if (this.sessionToken) {
        this.sessionToken.leaseExpiresAt = response.leaseExpiresAt;
      }
      this.updateLocalAuthorityExpiry(response.leaseExpiresAt);
      this.scheduleLeaseExpiry(generation);
    } catch (err) {
      // Network failures never extend the lease. The local expiry timer stays
      // armed and closes the transport if renewal cannot get through.
      console.debug(
        "[realtime-voice] Failed to renew voice lease:",
        (err as Error).message,
      );
    } finally {
      this.leaseHeartbeatInFlight = false;
    }
  }

  private terminateForAuthority(
    terminalEvent: "expired" | null,
    error: string,
  ): Promise<void> {
    if (this.authorityTerminationPromise) {
      return this.authorityTerminationPromise;
    }

    const terminalRequest = terminalEvent
      ? this.claimTerminalLeaseRequest(terminalEvent)
      : null;
    this.authorityTerminationError = error;
    this.leaseTerminalReported = true;
    this.destroyed = true;
    this.stopLeaseReporting();
    const runtime = getVoiceRuntimeState();
    if (runtime.activeSession === this) runtime.activeSession = null;
    if (this._state !== "disconnecting") this.setState("disconnecting");

    this.authorityTerminationPromise = (async () => {
      const transportClose = this.disconnectTransportImmediately();
      const finishClosure = this.finishVoiceClosure(
        terminalRequest,
        transportClose,
      );

      this.stopEchoGuardMonitor();
      this.assistantOutputActive = false;
      this.recentOutputActiveUntil = 0;
      this.softInputMuted = false;
      this.inputActive = false;
      this.stopDelegation();
      this.stopConversationUpdates();
      this.transcript.reset();

      this.sessionToken = null;
      this.sessionProvider = "stella";
      this.authorityLocalExpiresAt = null;
      this.inputEnergyBuffer = null;
      this.outputEnergyBuffer = null;
      if (this._state === "disconnecting") this.setState("error", error);

      await finishClosure;
    })();
    return this.authorityTerminationPromise;
  }

  // ---------------------------------------------------------------------------
  // Server event handling
  // ---------------------------------------------------------------------------

  private handleServerEvent(event: Record<string, unknown>) {
    const type = typeof event.type === "string" ? event.type : "";

    if (this.appends.handleEvent(event)) return;
    if (this.delegation?.handleEvent(event)) return;

    switch (type) {
      case "session.started":
      case "session.closed":
      case "session.updated":
        break;

      case "session.input_transcript.delta":
        this.markUserSpeaking();
        this.transcript.push({
          role: "user",
          delta: stringField(event, "delta"),
          startMs: numberField(event, "start_ms"),
          endMs: numberField(event, "end_ms"),
        });
        break;

      case "session.output_transcript.delta":
        this.markAssistantSpeaking();
        this.transcript.push({
          role: "assistant",
          delta: stringField(event, "delta"),
          startMs: numberField(event, "start_ms"),
          endMs: numberField(event, "end_ms"),
        });
        break;

      // The BYOK Realtime routes still speak the old vocabulary.
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.markAssistantSpeaking();
        this.transcript.push({
          role: "assistant",
          delta: stringField(event, "delta"),
        });
        break;

      case "conversation.item.input_audio_transcription.delta":
        this.markUserSpeaking();
        this.transcript.push({
          role: "user",
          delta: stringField(event, "delta"),
        });
        break;

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
      case "conversation.item.input_audio_transcription.completed":
        this.transcript.flush();
        break;

      case "session.output_audio.started":
      case "output_audio.started":
        this.markAssistantSpeaking();
        break;

      case "session.output_audio.done":
      case "output_audio.done":
        this.markAssistantIdle();
        break;

      case "input_audio_buffer.speech_started":
        this.markUserSpeaking();
        break;

      case "input_audio_buffer.speech_stopped":
        this.transcript.flush();
        this.emit({ type: "user-speaking-end" });
        break;

      case "session.error":
      case "error": {
        const error = isEventRecord(event.error) ? event.error : null;
        const message =
          typeof error?.message === "string" && error.message.trim()
            ? error.message.trim()
            : "Unknown realtime voice provider error";
        console.error("[realtime-voice] Provider error:", message);
        break;
      }

      default:
        break;
    }
  }

  private markUserSpeaking() {
    if (!this.userSpeakingEmitted) {
      this.userSpeakingEmitted = true;
      this.emit({ type: "user-speaking-start" });
    }
  }

  private markAssistantSpeaking() {
    this.recentOutputActiveUntil = Date.now() + ECHO_GUARD_RELEASE_MS;
    if (!this.assistantOutputActive) {
      this.assistantOutputActive = true;
      this.emit({ type: "speaking-start" });
    }
    this.startEchoGuardMonitor();
    this.syncEchoGuard();
  }

  private markAssistantIdle() {
    this.recentOutputActiveUntil = Date.now() + ECHO_GUARD_RELEASE_MS;
    if (this.assistantOutputActive) {
      this.assistantOutputActive = false;
      this.emit({ type: "speaking-end" });
    }
    this.startEchoGuardMonitor();
    this.syncEchoGuard();
  }

  /**
   * One reconstructed utterance. User turns can hang up the live turn; our own
   * turns are remembered so a mid-call update never repeats them back.
   */
  private handleCompletedTurn(turn: CompletedTranscriptTurn) {
    this.emit({
      type:
        turn.role === "user" ? "user-transcript" : "assistant-transcript",
      text: turn.text,
      isFinal: true,
    });

    if (turn.role === "assistant") {
      this.rememberSpoken(turn.text);
      this.markAssistantIdle();
      return;
    }

    if (this.userSpeakingEmitted) {
      this.userSpeakingEmitted = false;
      this.emit({ type: "user-speaking-end" });
    }

    if (matchesGoodbye(turn.text)) {
      queueMicrotask(() => {
        try {
          window.electronAPI?.voice?.toggleRtc?.();
        } catch (err) {
          console.debug(
            "[realtime-voice] goodbye toggle failed:",
            (err as Error).message,
          );
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private async tearDown() {
    this.stopLeaseReporting();
    const terminalRequest = this.claimTerminalLeaseRequest("ended");
    const transportClose = this.disconnectTransportImmediately();
    const finishClosure = this.finishVoiceClosure(
      terminalRequest,
      transportClose,
    );
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;
    this.userSpeakingEmitted = false;

    this.stopDelegation();
    this.stopConversationUpdates();
    this.transcript.reset();

    await finishClosure;
    this.sessionToken = null;
    this.sessionProvider = "stella";
    this.inputEnergyBuffer = null;
    this.outputEnergyBuffer = null;
  }

  /** Tear down state without awaiting (used inside synchronous onClose paths). */
  private cleanupAfterConnectionLoss() {
    this.stopLeaseReporting();
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;
    this.userSpeakingEmitted = false;
    this.stopDelegation();
    this.stopConversationUpdates();
    this.transcript.reset();
  }
}

const stringField = (event: Record<string, unknown>, key: string): string => {
  const value = event[key];
  return typeof value === "string" ? value : "";
};

const numberField = (
  event: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};
