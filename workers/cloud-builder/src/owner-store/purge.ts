/**
 * Deleting conversations. A conversation's transcript and its R2 segments
 * live in its `OrchestratorSession`, so only that object can say they are
 * gone: the owner object asks it (`POST /purge`) and deletes its own rows for
 * the conversation only once it has said so.
 *
 * Two paths share this:
 *  - `conversations.purge`, the job scheduled when a `conversation.deleted`
 *    event lands. The conversation row stays as a tombstone so late events
 *    cannot bring it back.
 *  - `purgeConversationData`, the reset/delete hook. It purges every
 *    conversation this object knows (the index and the agent threads under
 *    it), then deletes the rows outright.
 */

import type { JobDef, OwnerContext, OwnerDb, OwnerJobs, PurgeDef } from "./registry.js";

/** Orchestrator purges per hook call; the caller calls again while pending. */
const PURGE_BATCH = 25;
/** The job retries on its own backoff; give a stuck orchestrator a day of it. */
const PURGE_JOB_MAX_ATTEMPTS = 30;

export const CONVERSATION_PURGE_JOB = "conversations.purge";

export type ConversationPurgeJob = { conversationId: string };

/** Schedule the purge of one deleted conversation. Idempotent per conversation. */
export const scheduleConversationPurge = (
  jobs: OwnerJobs,
  conversationId: string,
  now: number,
): void => {
  jobs.schedule(
    CONVERSATION_PURGE_JOB,
    now,
    { conversationId } satisfies ConversationPurgeJob,
    { id: `purge:${conversationId}` },
  );
};

/**
 * Ask the conversation's orchestrator to delete its storage. True only when it
 * confirmed: an incomplete drain answers 202 `{purged:false}`, which is still
 * `ok`, so the body decides.
 */
const purgeOrchestrator = async (
  env: Cloudflare.Env,
  conversationId: string,
): Promise<boolean> => {
  try {
    const response = await env.ORCHESTRATOR_SESSIONS.getByName(conversationId).fetch(
      "https://orchestrator-session/purge",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (!response.ok) return false;
    const verdict = (await response.json().catch(() => null)) as { purged?: unknown } | null;
    return verdict?.purged === true;
  } catch {
    return false;
  }
};

/** Delete the agent threads, attempts and their side rows under one conversation. */
const deleteThreadRows = (db: OwnerDb, jobs: OwnerJobs, conversationId: string): void => {
  const turns = db.all<{ turn_id: string }>(
    `SELECT turn_id FROM agent_turns WHERE conversation_id = ?
       OR thread_id IN (SELECT thread_id FROM agent_threads WHERE conversation_id = ?)`,
    conversationId,
    conversationId,
  );
  for (const { turn_id } of turns) {
    jobs.cancel(`dispatch:${turn_id}`);
    db.run("DELETE FROM agent_turn_files WHERE turn_id = ?", turn_id);
    db.run("DELETE FROM agent_dispatch_prompts WHERE turn_id = ?", turn_id);
    db.run("DELETE FROM agent_turns WHERE turn_id = ?", turn_id);
  }
  db.run(
    `DELETE FROM agent_cancel_receipts
      WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE conversation_id = ?)`,
    conversationId,
  );
  db.run("DELETE FROM agent_threads WHERE conversation_id = ?", conversationId);
};

const runConversationPurge = async (ctx: OwnerContext, payload: unknown): Promise<void> => {
  const { conversationId } = payload as ConversationPurgeJob;
  if (typeof conversationId !== "string" || !conversationId) return;
  if (!(await purgeOrchestrator(ctx.env, conversationId))) {
    // Thrown so the store retries with backoff; the rows stay until then.
    throw new Error("The conversation's storage is not purged yet.");
  }
  deleteThreadRows(ctx.db, ctx.jobs, conversationId);
  // Keep the tombstone, without the user's words.
  ctx.db.run(
    `UPDATE conversations SET title = '', last_preview = NULL, last_role = NULL, activity = NULL
      WHERE conversation_id = ? AND deleted_at IS NOT NULL`,
    conversationId,
  );
};

export const conversationPurgeJob: JobDef = {
  maxAttempts: PURGE_JOB_MAX_ATTEMPTS,
  run: runConversationPurge,
};

/**
 * Reset and account deletion: purge every conversation's orchestrator, then
 * delete the conversation index, the agent threads and the edit receipts.
 * The owner is fenced with no turns running while this runs.
 */
export const purgeConversationData: PurgeDef = async (ctx) => {
  const conversations = ctx.db.all<{ conversation_id: string }>(
    `SELECT conversation_id FROM conversations
     UNION SELECT conversation_id FROM agent_threads
     ORDER BY conversation_id LIMIT ?`,
    PURGE_BATCH,
  );
  const purged = await Promise.all(
    conversations.map(async ({ conversation_id }) => ({
      conversationId: conversation_id,
      purged: await purgeOrchestrator(ctx.env, conversation_id),
    })),
  );
  for (const { conversationId, purged: done } of purged) {
    if (!done) continue;
    ctx.jobs.cancel(`purge:${conversationId}`);
    deleteThreadRows(ctx.db, ctx.jobs, conversationId);
    ctx.db.run("DELETE FROM conversations WHERE conversation_id = ?", conversationId);
  }
  if (conversations.length === PURGE_BATCH || purged.some((entry) => !entry.purged)) {
    return { pending: true };
  }
  // Every conversation is gone; what is left has no conversation to name.
  for (const kind of ["agentThreads.dispatch", CONVERSATION_PURGE_JOB]) {
    for (const { id } of ctx.db.all<{ id: string }>(
      "SELECT id FROM owner_jobs WHERE kind = ?",
      kind,
    )) {
      ctx.jobs.cancel(id);
    }
  }
  for (const table of [
    "agent_turn_files",
    "agent_dispatch_prompts",
    "agent_turns",
    "agent_cancel_receipts",
    "conversation_edits",
  ]) {
    ctx.db.run(`DELETE FROM ${table}`);
  }
  return { pending: false };
};
