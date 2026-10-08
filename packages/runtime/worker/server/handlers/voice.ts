import { Effect } from "effect";
import {
  METHOD_NAMES,
  type RuntimeVoiceChatPayload,
  type RuntimeVoiceOrchestratorConfig,
  type RuntimeVoiceToolCallPayload,
} from "@stella/contracts/protocol";
import { VoiceUnavailableError } from "../errors.js";
import * as HostBus from "../host-bus.js";
import { piChatsFor, piRuntimeEnabled } from "../pi-chats.js";
import { piVoiceChat } from "../pi-voice.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

const voiceSession = WorkerSessions.sessionOrFail(
  () => new VoiceUnavailableError(),
);

export const voiceHandlers: WorkerRpcHandlers = {
  // On pi-durable a voice call talks to the conversation's harness: what was
  // said is written into its transcript, the voice model's requests are
  // hidden turns of its orchestrator, and a call starts with its history.
  [METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT]: (params) =>
    Effect.gen(function* () {
      const session = yield* voiceSession;
      const said = params as {
        conversationId: string;
        eventId: string;
        timestamp: number;
        role: "user" | "assistant";
        text: string;
        uiVisibility?: "visible" | "hidden";
        voiceSession?: { durationMs: number };
      };
      if (piRuntimeEnabled()) {
        const hostBus = yield* HostBus.Service;
        return yield* fromPromise(async () => {
          await (await piChatsFor(session, hostBus)).voiceTranscript(said.conversationId, {
            eventId: said.eventId,
            role: said.role,
            text: said.text,
            timestamp: said.timestamp,
            ...(said.uiVisibility === "hidden" ? { hidden: true } : {}),
            ...(said.voiceSession ? { voiceSession: said.voiceSession } : {}),
          });
          return { ok: true as const };
        });
      }
      return yield* fromPromise(async () => session.voice.persistTranscript(said));
    }),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT]: (params) =>
    Effect.gen(function* () {
      const session = yield* voiceSession;
      const payload = params as RuntimeVoiceChatPayload;
      if (piRuntimeEnabled()) {
        const hostBus = yield* HostBus.Service;
        return yield* fromPromise(async () =>
          piVoiceChat(await piChatsFor(session, hostBus), hostBus, payload),
        );
      }
      return yield* fromPromise(() => session.voice.orchestratorChat(payload));
    }),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG]: (params) =>
    Effect.gen(function* () {
      const session = yield* voiceSession;
      const request = params as { conversationId: string };
      const config = yield* fromPromise(() =>
        session.voice.getOrchestratorConfig(request),
      );
      if (!piRuntimeEnabled()) return config;
      const hostBus = yield* HostBus.Service;
      const history = yield* fromPromise(async () =>
        (await piChatsFor(session, hostBus)).voiceHistory(request.conversationId),
      );
      const { history: _loopHistory, ...rest } = config;
      return {
        ...rest,
        ...(history.length > 0 ? { history } : {}),
      } satisfies RuntimeVoiceOrchestratorConfig;
    }),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL]: (params) =>
    Effect.flatMap(voiceSession, (session) =>
      fromPromise(() =>
        session.voice.executeTool(params as RuntimeVoiceToolCallPayload),
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH]: (params) =>
    Effect.flatMap(voiceSession, (session) =>
      fromPromise(() =>
        session.voice.webSearch(
          params as {
            query: string;
            category?: string;
          },
        ),
      ),
    ),
};
