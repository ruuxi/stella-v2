import { Effect } from "effect";
import {
  METHOD_NAMES,
  type RuntimeVoiceToolCallPayload,
} from "@stella/contracts/protocol";
import { VoiceUnavailableError } from "../errors.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

const voiceSession = WorkerSessions.sessionOrFail(
  () => new VoiceUnavailableError(),
);

export const voiceHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT]: (params) =>
    Effect.map(voiceSession, (session) =>
      session.voice.persistTranscript(
        params as {
          conversationId: string;
          role: "user" | "assistant";
          text: string;
          uiVisibility?: "visible" | "hidden";
          voiceSession?: { durationMs: number };
        },
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT]: (params) =>
    Effect.flatMap(voiceSession, (session) =>
      fromPromise(() =>
        session.voice.orchestratorChat(
          params as {
            requestId: string;
            conversationId: string;
            message: string;
          },
        ),
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG]: (params) =>
    Effect.flatMap(voiceSession, (session) =>
      fromPromise(() =>
        session.voice.getOrchestratorConfig(
          params as {
            conversationId: string;
          },
        ),
      ),
    ),

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
