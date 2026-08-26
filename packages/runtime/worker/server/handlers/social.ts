import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import {
  SocialSessionsUnavailableError,
  WorkerRequestError,
} from "../errors.js";
import { asTrimmedString } from "../attachments.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

const socialSession = WorkerSessions.sessionOrFail(
  () => new SocialSessionsUnavailableError(),
);

export const socialHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE]: (params) =>
    Effect.gen(function* () {
      const session = yield* socialSession;
      const payload = params as { roomId?: string; workspaceLabel?: string };
      const roomId = asTrimmedString(payload?.roomId);
      if (!roomId) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "Room ID is required." }),
        );
      }
      return yield* fromPromise(() =>
        session.social.createSession({
          roomId,
          workspaceLabel: asTrimmedString(payload?.workspaceLabel) || undefined,
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS]: (params) =>
    Effect.gen(function* () {
      const session = yield* socialSession;
      const payload = params as {
        sessionId?: string;
        status?: "active" | "paused" | "ended";
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      if (!sessionId) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "Session ID is required." }),
        );
      }
      const status = payload?.status;
      if (status !== "active" && status !== "paused" && status !== "ended") {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "Session status is invalid." }),
        );
      }
      return yield* fromPromise(() =>
        session.social.updateSessionStatus({
          sessionId,
          status,
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN]: (params) =>
    Effect.gen(function* () {
      const session = yield* socialSession;
      const payload = params as {
        sessionId?: string;
        prompt?: string;
        agentType?: string;
        clientTurnId?: string;
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      const prompt = asTrimmedString(payload?.prompt);
      if (!sessionId) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "Session ID is required." }),
        );
      }
      if (!prompt) {
        return yield* Effect.fail(
          new WorkerRequestError({ message: "Prompt is required." }),
        );
      }
      return yield* fromPromise(() =>
        session.social.queueTurn({
          sessionId,
          prompt,
          agentType: asTrimmedString(payload?.agentType) || undefined,
          clientTurnId: asTrimmedString(payload?.clientTurnId) || undefined,
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS]: () =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      return (
        sessions.current()?.social.getSnapshot() ??
        createEmptySocialSessionServiceSnapshot()
      );
    }),
};
