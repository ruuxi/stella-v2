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
  CompactionEntry,
  defineDoc,
  defineEntry,
  type Conversation,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type { JournalCheckpoint, JournalCheckpointFirstKept } from "@stella/contracts/journal-checkpoint";
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
  /** The newest compaction of this transcript published as the journal's checkpoint. */
  publishedCheckpoint?: number;
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

/** Where the journal says a new transcript of the conversation starts. */
export type JournalStart = {
  /** The journal's bounded context window opens here (`Journal.contextStartSeq`). */
  contextStartSeq: number;
  /** The conversation's latest compaction checkpoint, published by whichever host compacted. */
  checkpoint?: JournalCheckpoint;
};

/** How a transcript's first import seeds it (`journalImportAfter`). */
export type JournalSeed = { fromSeq: number; checkpoint?: JournalCheckpoint };

/**
 * The journal seq a transcript's import reads after: where it left off, or,
 * for one that never imported, where the conversation's context starts. That
 * is the latest compaction checkpoint any host published, its summary
 * followed by every message after it; before any host compacted, the
 * journal's context window. Every host seeds a transcript the same way, so a
 * long conversation is never replayed whole, and from then on the
 * transcript's own compaction keeps its context in bounds.
 */
export const journalImportAfter = async (
  state: Readonly<JournalSyncState> | undefined,
  start: () => JournalStart | Promise<JournalStart>,
): Promise<{ after: number; seed?: JournalSeed }> => {
  if (state?.importedSeq !== undefined) return { after: state.importedSeq };
  const { contextStartSeq, checkpoint } = await start();
  return checkpoint
    ? { after: checkpoint.throughSeq, seed: { fromSeq: checkpoint.throughSeq + 1, checkpoint } }
    : { after: contextStartSeq - 1, seed: { fromSeq: contextStartSeq } };
};

/** A compaction this transcript took from the journal, which is never published back. */
const journalCheckpointOf = (entry: Pick<EntryRecord, "data"> | undefined): number | undefined => {
  const seq = (entry?.data as { journalCheckpoint?: unknown } | undefined)?.journalCheckpoint;
  return typeof seq === "number" ? seq : undefined;
};

const messageText = (message: Message | undefined): string => {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
};

/**
 * This transcript's newest compaction, for the journal, when it has not
 * published it yet: the summary as its model reads it and where the context
 * it kept starts. `ownTurnOf` names the turn of one of this host's own
 * prompts (an entry not written from the journal).
 */
export async function checkpointToPublish(
  harness: Harness,
  root: Conversation,
  ownTurnOf: (
    prompt: EntryRecord,
  ) => JournalCheckpointFirstKept | undefined | Promise<JournalCheckpointFirstKept | undefined>,
  context: Context,
): Promise<{ markerId: EntryId; summary: string; firstKept: JournalCheckpointFirstKept } | undefined> {
  const found = await harness.commit(async (tx) => {
    const doc = await tx.doc(JournalSyncDoc, root.id);
    const marker = await tx.latestHeadMarker(root.id);
    if (
      !marker ||
      marker.kind !== CompactionEntry.kind ||
      journalCheckpointOf(marker) !== undefined ||
      (doc.publishedCheckpoint ?? 0) >= marker.id
    ) {
      return undefined;
    }
    const summary = messageText(marker.model?.[0]);
    if (!summary) return undefined;
    const kept = await tx.entry(marker.head);
    const keptSeq = journalSeqOf(kept);
    if (keptSeq !== undefined) return { markerId: marker.id, summary, firstKept: { seq: keptSeq } as const };
    // One of this host's own: the prompt that opened its turn.
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries(
        { conversationId: root.id, order: "descending", maxEntryId: marker.head },
        ALIGN_SCAN_PAGE,
        cursor,
      );
      for (const entry of page.items) {
        if (entry.kind !== ENTRY_KIND.user) continue;
        const seq = journalSeqOf(entry);
        return seq === undefined
          ? { markerId: marker.id, summary, prompt: entry }
          : { markerId: marker.id, summary, firstKept: { seq } as const };
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }, context);
  if (!found) return undefined;
  if (found.firstKept) return { markerId: found.markerId, summary: found.summary, firstKept: found.firstKept };
  if (!found.prompt) return undefined;
  const firstKept = await ownTurnOf(found.prompt);
  return firstKept ? { markerId: found.markerId, summary: found.summary, firstKept } : undefined;
}

/** The compaction `checkpointToPublish` returned is in the journal now. */
export async function noteCheckpointPublished(
  harness: Harness,
  root: Conversation,
  markerId: EntryId,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(JournalSyncDoc, root.id);
    doc.publishedCheckpoint = Math.max(doc.publishedCheckpoint ?? 0, markerId);
    return undefined;
  }, context);
}

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
 * are; a prompt's client id goes on its first part, as a placed chat's does,
 * and a visible one's journal seq (its `message #N` id, `message-ids.ts`).
 */
const asWritten = ({ message, hidden, clientMsgId, seq }: JournalMessage): Message => {
  if (message.role !== "user") return message;
  const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return {
    ...message,
    content: parts.map((part, index) => {
      const marks = {
        ...(part as { stella?: Record<string, unknown> }).stella,
        ...(hidden && part.type === "text" ? { hidden: true } : {}),
        ...(clientMsgId && index === 0 ? { clientMsgId } : {}),
        ...(!hidden && index === 0 ? { seq } : {}),
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
  /** How a first import seeds the transcript (`journalImportAfter`). */
  seed?: JournalSeed,
): Promise<number> {
  let state = await harness.snapshot(JournalSyncDoc, root.id, context);
  const checkpoint = seed?.checkpoint;
  if (checkpoint && state?.importedSeq === undefined) {
    // The checkpoint's summary opens the transcript's context, as a
    // compaction of its own would; the messages after it follow.
    state = await harness.commit(async (tx) => {
      const doc = await tx.doc(JournalSyncDoc, root.id);
      if (doc.importedSeq === undefined) {
        await tx.appendEntry(root.id, {
          kind: CompactionEntry.kind,
          head: "self",
          model: [{ role: "user", content: checkpoint.summary, timestamp: Date.now() }],
          data: { reason: "threshold", journalCheckpoint: checkpoint.throughSeq },
        });
        doc.seededFromSeq = seed.fromSeq;
        doc.importedSeq = checkpoint.throughSeq;
      }
      return { ...doc };
    }, context);
  }
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
      if (doc.importedSeq === undefined && seed) doc.seededFromSeq = seed.fromSeq;
      doc.importedSeq = Math.max(doc.importedSeq ?? -1, throughSeq);
      return undefined;
    }, context);
  }
  return written;
}
