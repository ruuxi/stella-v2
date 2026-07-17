import { Effect } from "effect";
import {
  METHOD_NAMES,
  type RuntimeChatPayload,
} from "@stella/contracts/protocol";
import {
  ChatStoreUnavailableError,
  RunnerUnavailableError,
  WorkerRequestError,
} from "../errors.js";
import { asTrimmedString } from "../attachments.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

export const chatHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_START_CHAT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new ChatStoreUnavailableError(),
      );
      return yield* fromPromise(() =>
        session.agentRuns.startChat(params as RuntimeChatPayload),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT]: (params) =>
    Effect.gen(function* () {
      const payload = params as {
        conversationId?: string;
        threadId?: string;
        message?: string;
        metadata?: Record<string, unknown>;
      };
      const conversationId = asTrimmedString(payload.conversationId);
      const threadId = asTrimmedString(payload.threadId);
      const message = asTrimmedString(payload.message);
      if (!conversationId) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "conversationId is required." }),
        );
      }
      if (!threadId) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "threadId is required." }),
        );
      }
      if (!message) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "message is required." }),
        );
      }
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      return yield* fromPromise(() =>
        session.agentRuns.sendAgentInput({
          conversationId,
          threadId,
          message,
          ...(payload.metadata ? { metadata: payload.metadata } : {}),
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CANCEL]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      // Tolerate the runner still building (post-ready window): nothing to
      // cancel if it hasn't started yet.
      sessions
        .current()
        ?.runnerCell.get()
        ?.cancelLocalChat((params as { runId: string }).runId);
      return { ok: true };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const cancelled =
        sessions
          .current()
          ?.runnerCell.get()
          ?.cancelLocalChatByConversation(
            (params as { conversationId: string }).conversationId,
          ) ?? false;
      return { ok: true, cancelled };
    }),
};
