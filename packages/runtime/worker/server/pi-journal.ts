/**
 * The cloud journal of a conversation stored in the cloud, for the pi-durable
 * chat that runs it on this computer (`@stella/agent/host/desktop-journal`).
 * Turns go in through the runner's cloud transcript writer, the same durable,
 * lease-holding begin and finish the agent loops use; what other writers
 * journaled comes back through `history.read`, as the code tool's history
 * reads it.
 */
import type { DesktopJournal, JournalReadRecord } from "@stella/agent/host/desktop-journal";
import type { OpenSession } from "./sessions.js";

const READ_TIMEOUT_MS = 30_000;

export const cloudJournalFor = (
  session: OpenSession,
  conversationId: string,
): DesktopJournal | undefined => {
  // A conversation kept on this computer has no journal.
  if (conversationId.startsWith("local_")) return undefined;
  const deviceId = session.config.deviceId;
  const runner = () => {
    const current = session.runnerCell.get();
    if (!current) throw new Error("Stella's runtime is restarting.");
    return current;
  };
  return {
    contextStartSeq: async () =>
      (await runner().cloudJournal.history(conversationId)).contextStartSeq,
    read: async (afterSeq) => {
      const auth = runner().getStellaSiteAuth();
      if (!auth) throw new Error("Sign in to sync this conversation.");
      const response = await fetch(
        `${auth.baseUrl.replace(/\/+$/, "")}/conversations/${encodeURIComponent(conversationId)}/history/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            op: "read",
            fromSeq: afterSeq + 1,
            toSeq: Number.MAX_SAFE_INTEGER,
          }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        records?: JournalReadRecord[];
        complete?: boolean;
        error?: string;
      } | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? `The conversation's history did not load (${response.status}).`);
      }
      return { records: body.records ?? [], complete: body.complete !== false };
    },
    ownTurn: (turnId) =>
      turnId.startsWith(`desktop:${deviceId}:pi:`) ||
      turnId.startsWith(`voice:${deviceId}:pi:`),
    begin: async (turn) => {
      const ownerGeneration =
        turn.ownerGeneration ?? (await runner().cloudJournal.ownerGeneration());
      const ack = await runner().cloudJournal.begin({
        conversationId,
        ownerGeneration,
        localTurnId: turn.localTurnId,
        clientMsgId: turn.clientMsgId,
        userMessageJson: turn.userMessageJson,
        ...(turn.hidden ? { hidden: true } : {}),
        ...(turn.adopt ? { adoptExisting: true } : {}),
      });
      return { leaseToken: ack.leaseToken, ownerGeneration };
    },
    finish: async (turn) => {
      const status = await runner().cloudJournal.finish({
        conversationId,
        ownerGeneration: turn.ownerGeneration,
        localTurnId: turn.localTurnId,
        leaseToken: turn.leaseToken,
        records: turn.records,
        phase: turn.phase,
        ...(turn.notice ? { notice: turn.notice } : {}),
      });
      if (!status.queued) {
        throw new Error(`A turn was too large for the cloud journal (${status.reason}).`);
      }
    },
    appendVoice: async (said) => {
      await runner().cloudJournal.append({
        conversationId,
        appendId: said.appendId,
        records: [
          {
            kind: "message",
            role: said.role,
            payloadJson: said.payloadJson,
            ...(said.hidden ? { hidden: true } : {}),
          },
        ],
      });
    },
  };
};
