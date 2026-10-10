/**
 * A cloud-stored conversation's journal and a host's pi-durable transcript,
 * kept in step. The journal is what every device shows and the record of
 * every writer's turns; a host's transcript is what its orchestrator reads.
 * What other writers journaled (a turn sent from the phone, another
 * computer's) is written into the transcript, once each and marked with its
 * journal seq, so the orchestrator answers with the whole conversation and a
 * host never mirrors it back out.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineEntry,
  type Conversation,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import { noteRemoteReport } from "./agents.ts";

/** One journaled message, as a reader of the journal gets it. */
export type JournalMessage = {
  seq: number;
  /** The journal turn that wrote it. */
  turnId: string;
  role: "user" | "assistant" | "toolResult";
  /** A prompt no client shows (a wake, a report); still model context. */
  hidden: boolean;
  message: Message;
  /** A prompt's client id, which the sending client's pending message binds to. */
  clientMsgId?: string;
};

/**
 * A report of this host's cloud agent, for its orchestrator to answer; with
 * no text, one of the agent's messages settled without one of its own.
 */
export type JournalAgentReport = {
  seq: number;
  report: { threadId: string; requestId: string; text?: string };
};

/** The journal turn a transcript is mirroring now. */
export type JournalOpenTurn = {
  localTurnId: string;
  leaseToken: string;
  ownerGeneration: string;
  /** Its assistant and tool-result entries so far. */
  entries: number[];
};

export type JournalSyncState = {
  /** Random per transcript, so its turn ids never repeat in the journal. */
  syncId?: string;
  /** The newest journal seq written into the transcript. */
  importedSeq?: number;
  /**
   * The journal's context start the transcript was seeded from
   * (`journalImportAfter`). Absent on one seeded before that rule, which may
   * have read the whole journal.
   */
  seededFromSeq?: number;
  /** The newest transcript entry mirrored into the journal. */
  mirrored?: number;
  open?: JournalOpenTurn;
  /**
   * The journal epoch the transcript follows, when it started over on a new
   * one whose seqs repeat the old ones': its imports are new writes.
   */
  epoch?: number;
};

/** How far the transcript and the journal are in step, per conversation. */
export const JournalSyncDoc = defineDoc<JournalSyncState>({
  kind: "stella.journal-sync",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

const ENTRY_KIND = { user: "pi.user", assistant: "pi.assistant", toolResult: "pi.tool-result" } as const;

/**
 * Where a transcript's context starts after `alignJournalContext` cut it to
 * the journal's context start. It carries no message; its `head` is the
 * first entry kept, or itself when nothing after the cut is a prompt.
 */
export const JournalContextStartEntry = defineEntry("stella.journal-context-start");

const ALIGN_SCAN_PAGE = 64;

/**
 * The journal seq a transcript's import reads after: where it left off, or,
 * for one that never imported, just before the journal's context start (the
 * window the journal keeps for a turn, `contextStartSeq`). Every host seeds
 * a transcript there, so a long conversation is never replayed whole; from
 * then on the transcript's own compaction keeps its context in bounds.
 */
export const journalImportAfter = async (
  state: Readonly<JournalSyncState> | undefined,
  contextStartSeq: () => number | Promise<number>,
): Promise<{ after: number; seededFromSeq?: number }> => {
  if (state?.importedSeq !== undefined) return { after: state.importedSeq };
  const start = await contextStartSeq();
  return { after: start - 1, seededFromSeq: start };
};

/**
 * Bring a transcript seeded before `journalImportAfter`, which read the whole
 * journal, to the same start: a head marker at its first prompt from
 * `contextStartSeq` on, so older entries stay in it but out of context. One
 * that compaction or a reset already bounds is left as it is. Runs once per
 * transcript; returns whether it cut.
 */
export async function alignJournalContext(
  harness: Harness,
  root: Conversation,
  contextStartSeq: number,
  context: Context,
): Promise<boolean> {
  return await harness.commit(async (tx) => {
    const doc = await tx.doc(JournalSyncDoc, root.id);
    if (doc.importedSeq === undefined || doc.seededFromSeq !== undefined) return false;
    doc.seededFromSeq = contextStartSeq;
    const marker = await tx.latestHeadMarker(root.id);
    let firstKept: EntryId | undefined;
    let older: EntryId | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId: root.id, order: "descending" }, ALIGN_SCAN_PAGE, cursor);
      for (const entry of page.items) {
        const seq = journalSeqOf(entry);
        if (seq !== undefined && seq < contextStartSeq) {
          older = entry.id;
          break;
        }
        if (entry.kind === ENTRY_KIND.user) firstKept = entry.id;
      }
      cursor = page.next;
    } while (older === undefined && cursor !== undefined);
    // Nothing older than the start, or a compaction already opens the context after it.
    if (older === undefined || (marker && marker.head > older)) return false;
    await tx.appendEntry(root.id, { kind: JournalContextStartEntry.kind, head: firstKept ?? "self" });
    doc.importedSeq = Math.max(doc.importedSeq, contextStartSeq - 1);
    return true;
  }, context);
}

/** The journal seq of an entry written from the journal, which is never mirrored back. */
export const journalSeqOf = (entry: Pick<EntryRecord, "data"> | undefined): number | undefined => {
  const seq = (entry?.data as { journalSeq?: unknown } | undefined)?.journalSeq;
  return typeof seq === "number" ? seq : undefined;
};

/**
 * A hidden prompt's text parts are marked, as the host's own hidden prompts
 * are; a prompt's client id goes on its first part, as a placed chat's does.
 */
const asWritten = ({ message, hidden, clientMsgId }: JournalMessage): Message => {
  if (message.role !== "user" || (!hidden && !clientMsgId)) return message;
  const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return {
    ...message,
    content: parts.map((part, index) => {
      const marks = {
        ...(part as { stella?: Record<string, unknown> }).stella,
        ...(hidden && part.type === "text" ? { hidden: true } : {}),
        ...(clientMsgId && index === 0 ? { clientMsgId } : {}),
      };
      return Object.keys(marks).length > 0 ? { ...part, stella: marks } : part;
    }),
  } as Message;
};

/**
 * Write what other writers journaled after the transcript's `importedSeq`
 * into it, in journal order, and advance `importedSeq` to `throughSeq`. A
 * write lands after whatever run is going on, like any passive entry.
 */
export async function importJournal(
  harness: Harness,
  root: Conversation,
  messages: readonly (JournalMessage | JournalAgentReport)[],
  throughSeq: number,
  context: Context,
  /** The context start a first import began at (`journalImportAfter`). */
  seededFromSeq?: number,
): Promise<number> {
  const state = await harness.snapshot(JournalSyncDoc, root.id, context);
  const imported = state?.importedSeq ?? -1;
  const requestId = (seq: number) => (state?.epoch ? `journal:${state.epoch}:${seq}` : `journal:${seq}`);
  let written = 0;
  for (const record of messages) {
    if (record.seq <= imported) continue;
    if ("report" in record) {
      const { text } = record.report;
      // Only an agent this conversation started reports to its orchestrator.
      const known = await harness.commit((tx) => noteRemoteReport(tx, root.id, record.report), context);
      if (known && text) {
        await root.submit(
          { type: "input", requestId: requestId(record.seq), content: [{ type: "text", text }], whenBusy: "followUp" },
          context,
        );
        written += 1;
      }
      continue;
    }
    await root.submit(
      {
        type: "write",
        requestId: requestId(record.seq),
        entry: { kind: ENTRY_KIND[record.role], model: [asWritten(record)], data: { journalSeq: record.seq } },
      },
      context,
    );
    written += 1;
  }
  if (throughSeq > imported) {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(JournalSyncDoc, root.id);
      if (doc.importedSeq === undefined && seededFromSeq !== undefined) doc.seededFromSeq = seededFromSeq;
      doc.importedSeq = Math.max(doc.importedSeq ?? -1, throughSeq);
      return undefined;
    }, context);
  }
  return written;
}
