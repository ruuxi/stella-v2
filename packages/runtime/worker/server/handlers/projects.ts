import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { UserAppProjectsUnavailableError } from "../errors.js";
import { asTrimmedString } from "../attachments.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

const projectsSession = WorkerSessions.sessionOrFail(
  () => new UserAppProjectsUnavailableError(),
);

export const projectsHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_PROJECTS_LIST]: () =>
    Effect.flatMap(projectsSession, (session) =>
      fromPromise(() => session.userApps.list()),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_PROJECTS_START]: (params) =>
    Effect.flatMap(projectsSession, (session) =>
      fromPromise(() =>
        session.userApps.startProject(
          asTrimmedString((params as { slug?: unknown })?.slug),
        ),
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_PROJECTS_STOP]: (params) =>
    Effect.flatMap(projectsSession, (session) =>
      fromPromise(() =>
        session.userApps.stopProject(
          asTrimmedString((params as { slug?: unknown })?.slug),
        ),
      ),
    ),
};
