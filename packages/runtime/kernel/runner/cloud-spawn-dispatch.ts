/**
 * Host-side implementation of the tool host's `cloudDispatch` capability.
 *
 * A `spawn_agent` call whose `workspace` names a subject that does not live on
 * this machine (drive, project, app, stella) is handed to Stella's cloud
 * runtime instead of LocalAgentManager. The call goes out over the signed-in
 * user's own Convex identity — the same JWT the runtime already uses for its
 * other backend calls — so the cloud bills and authorizes the person who asked.
 */

import type {
  CloudDispatchRequest,
  CloudDispatchResult,
} from "../tools/types.js";

/**
 * A cloud spawn is one mutation that returns as soon as the thread row exists.
 * Anything slower is a dead connection, and a tool call that never returns is
 * worse than one that reports the truth.
 */
const CLOUD_SPAWN_TIMEOUT_MS = 30_000;

export type CloudSpawnDispatcherOptions = {
  /** Convex `anyApi` handle used to reference the backend mutation. */
  convexApi: unknown;
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  /**
   * Reads a Convex query over the same identity as `mutation`. Used to find
   * the cloud conversation the owner is actually chatting in; without it the
   * dispatcher can only guess from what this process has spawned before.
   */
  query?: (ref: unknown, args: unknown) => Promise<unknown>;
  /** True when this device has both a deployment URL and a user token. */
  isSignedIn: () => boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

/**
 * Convex wraps a thrown `ConvexError` in a request-id preamble and a stack.
 * The backend's message is the part worth showing the model, so unwrap it.
 */
const readConvexErrorText = (error: unknown): string => {
  const data = asRecord(error)?.data;
  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }
  const dataMessage = asRecord(data)?.message;
  if (typeof dataMessage === "string" && dataMessage.trim()) {
    return dataMessage.trim();
  }
  const message = error instanceof Error ? error.message : String(error);
  const uncaught = /Uncaught ConvexError:\s*([\s\S]*?)(?:\n\s+at\s|$)/.exec(
    message,
  );
  return (uncaught?.[1] ?? message).trim();
};

const withTimeout = async <T>(
  promise: Promise<T>,
  workspace: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Stella's cloud did not accept the ${workspace} agent within 30s — this device may be offline. Check the running agents before retrying so the same work does not start twice.`,
            ),
          );
        }, CLOUD_SPAWN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const createCloudSpawnDispatcher = (
  options: CloudSpawnDispatcherOptions,
) => {
  /**
   * Last cloud conversation each local conversation dispatched into. Only a
   * fallback for when the owner's live conversation cannot be read; the
   * server is the real answer, this is the memory of one process.
   */
  const cloudConversationIds = new Map<string, string>();

  const conversationsRef = () =>
    (options.convexApi as { cloud_apps: { listMyConversations: unknown } })
      .cloud_apps.listMyConversations;

  /**
   * The cloud conversation the owner is chatting in right now — the newest
   * one, which is exactly the row the cloud tail and composer bind to.
   * Dispatching into it groups desktop-spawned agents with the conversation
   * the user can see; letting the backend mint a fresh one instead would
   * silently re-point that chat at a conversation they never opened.
   */
  const activeCloudConversationId = async (): Promise<string | undefined> => {
    const read = options.query;
    if (!read) return undefined;
    try {
      const rows = await read(conversationsRef(), {});
      if (!Array.isArray(rows)) return undefined;
      const newest = asRecord(rows[0])?.conversationId;
      return typeof newest === "string" && newest ? newest : undefined;
    } catch {
      // A spawn is worth more than perfect grouping: fall back rather than
      // failing the tool call on a read this dispatch does not depend on.
      return undefined;
    }
  };

  return async (
    request: CloudDispatchRequest,
  ): Promise<CloudDispatchResult> => {
    if (!options.isSignedIn()) {
      throw new Error(
        `The ${request.workspace} workspace runs in your Stella cloud, and this device is signed out. Sign in, or use workspace "computer" to run the work here.`,
      );
    }
    const ref = (
      options.convexApi as {
        cloud_apps: { spawnCloudAgentFromDesktop: unknown };
      }
    ).cloud_apps.spawnCloudAgentFromDesktop;

    const dispatch = async (
      cloudConversationId?: string,
    ): Promise<CloudDispatchResult> => {
      const raw = await withTimeout(
        options.mutation(ref, {
          workspace: request.workspace,
          description: request.description,
          prompt: request.prompt,
          ...(cloudConversationId
            ? { conversationId: cloudConversationId }
            : {}),
        }),
        request.workspace,
      );
      const result = asRecord(raw);
      const threadId = result?.threadId;
      const conversationId = result?.conversationId;
      if (typeof threadId !== "string" || typeof conversationId !== "string") {
        throw new Error(
          "Stella's cloud accepted the spawn but returned no thread id.",
        );
      }
      return { threadId, conversationId };
    };

    const knownConversationId =
      (await activeCloudConversationId()) ??
      cloudConversationIds.get(request.conversationId);
    try {
      const dispatched = await dispatch(knownConversationId);
      cloudConversationIds.set(
        request.conversationId,
        dispatched.conversationId,
      );
      return dispatched;
    } catch (error) {
      const text = readConvexErrorText(error);
      // The remembered cloud conversation can be deleted from the web app
      // while this process keeps running. Forget it and start a fresh one
      // rather than making the user's spawn fail on our own stale cache.
      if (knownConversationId && /conversation not found/i.test(text)) {
        cloudConversationIds.delete(request.conversationId);
        const dispatched = await dispatch();
        cloudConversationIds.set(
          request.conversationId,
          dispatched.conversationId,
        );
        return dispatched;
      }
      throw new Error(text);
    }
  };
};
