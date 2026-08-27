import {
  CONVERSATION_EDIT_PAGES_PER_PASS,
  type ConversationEditRequest,
  type ConversationEditResult,
  type ForkConversationEditRequest,
  type ForkConversationEditResult,
  type RewindConversationEditRequest,
  type RewindConversationEditResult,
} from "./conversation-edit-protocol.js";

export type ConversationEditWorkerEnv = {
  ORCHESTRATOR_SESSIONS: DurableObjectNamespace;
};

type JsonResponse = Record<string, unknown>;

class ConversationEditHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: JsonResponse,
  ) {
    super(
      typeof body.message === "string"
        ? body.message
        : "Conversation edit failed.",
    );
  }
}

const post = async <T extends JsonResponse>(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
): Promise<T> => {
  const response = await stub.fetch(`https://orchestrator-session${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as JsonResponse;
  if (!response.ok)
    throw new ConversationEditHttpError(response.status, payload);
  return payload as T;
};

const fork = async (
  env: ConversationEditWorkerEnv,
  request: ForkConversationEditRequest,
): Promise<ForkConversationEditResult> => {
  const source = env.ORCHESTRATOR_SESSIONS.getByName(
    request.sourceConversationId,
  );
  const target = env.ORCHESTRATOR_SESSIONS.getByName(
    request.targetConversationId,
  );
  const acquired = await post<{
    sourceEpoch: number;
    sourceLastSeq: number;
  }>(source, "/internal/edit/fork-source/acquire", request);
  await post(target, "/internal/edit/fork-target/begin", {
    ...request,
    sourceEpoch: acquired.sourceEpoch,
    sourceLastSeq: acquired.sourceLastSeq,
  });

  for (let page = 0; page < CONVERSATION_EDIT_PAGES_PER_PASS; page += 1) {
    const status = await post<{
      state: "copying" | "complete";
      nextSeq: number;
      targetEpoch: number;
      lastSeq: number;
      lastPreview?: string;
      lastRole?: string;
    }>(target, "/internal/edit/fork-target/status", request);
    if (status.state === "complete") {
      // Target import can spend long enough copying R2 spills for the source
      // lease to expire. Revalidate the optimistic source head immediately
      // before publication; otherwise a turn admitted in that expiry window
      // could make a stale fork look successful.
      await post(source, "/internal/edit/fork-source/acquire", request);
      await post(target, "/internal/edit/fork-target/release", request);
      await post(source, "/internal/edit/fork-source/release", request);
      return {
        complete: true,
        kind: "fork",
        operationId: request.operationId,
        sourceConversationId: request.sourceConversationId,
        targetConversationId: request.targetConversationId,
        sourceEpoch: acquired.sourceEpoch,
        throughSeq: request.throughSeq,
        targetEpoch: status.targetEpoch,
        lastSeq: status.lastSeq,
        ...(status.lastPreview ? { lastPreview: status.lastPreview } : {}),
        ...(status.lastRole ? { lastRole: status.lastRole } : {}),
      };
    }
    if (status.nextSeq > request.throughSeq) {
      await post(target, "/internal/edit/fork-target/complete", request);
      continue;
    }
    const exported = await post<{
      rows: unknown[];
      nextSeq: number;
      complete: boolean;
    }>(source, "/internal/edit/fork-source/export", {
      ...request,
      fromSeq: status.nextSeq,
    });
    await post(target, "/internal/edit/fork-target/import", {
      ...request,
      rows: exported.rows,
      nextSeq: exported.nextSeq,
      complete: exported.complete,
    });
  }

  const status = await post<{ nextSeq: number; targetEpoch: number }>(
    target,
    "/internal/edit/fork-target/status",
    request,
  );
  return {
    complete: false,
    kind: "fork",
    operationId: request.operationId,
    sourceConversationId: request.sourceConversationId,
    targetConversationId: request.targetConversationId,
    sourceEpoch: acquired.sourceEpoch,
    throughSeq: request.throughSeq,
    targetEpoch: status.targetEpoch,
    lastSeq: Math.min(status.nextSeq - 1, request.throughSeq),
    pendingAtSeq: status.nextSeq,
  };
};

const rewind = async (
  env: ConversationEditWorkerEnv,
  request: RewindConversationEditRequest,
): Promise<RewindConversationEditResult> => {
  const target = env.ORCHESTRATOR_SESSIONS.getByName(request.conversationId);
  return await post<RewindConversationEditResult>(
    target,
    "/internal/edit/rewind",
    request,
  );
};

/** One bounded, resumable pass. Convex retries the same operation id. */
export const runConversationEdit = async (
  env: ConversationEditWorkerEnv,
  request: ConversationEditRequest,
): Promise<ConversationEditResult> =>
  request.kind === "fork"
    ? await fork(env, request)
    : await rewind(env, request);

export const conversationEditErrorResponse = (error: unknown): Response => {
  if (error instanceof ConversationEditHttpError) {
    return Response.json(error.body, {
      status: error.status,
      headers: { "cache-control": "no-store" },
    });
  }
  return Response.json(
    {
      code: "conversation_edit_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
};
