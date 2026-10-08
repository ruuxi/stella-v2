/**
 * A conversation stored in the cloud, run on this computer. Its turns run in
 * the local pi-durable transcript and are mirrored into the conversation's
 * journal, which every other device reads, through the local-turn protocol
 * the agent loops use: `begin` journals a turn's prompt and holds the
 * journal's lease, `finish` journals what the turn produced and how it ended.
 * Every user entry opens a journal turn (a steer mid-run opens the next one);
 * what a voice call said goes in outside any turn, as the loops' voice does.
 *
 * The other way, what other writers journaled (a turn sent from the phone,
 * another computer's) is imported into the transcript before this computer
 * answers, and while the conversation is open, so its orchestrator and its
 * timeline have the whole conversation.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { LiveDoc, watchEvents, type AgentEventStream, type Conversation, type EntryId, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { piJournalUserMessage, type PiUserMessage } from "@stella/contracts/pi-chat";
import {
  importJournal,
  journalSeqOf,
  JournalSyncDoc,
  type JournalAgentReport,
  type JournalMessage,
  type JournalOpenTurn,
  type JournalSyncState,
} from "../stella/journal-sync.ts";

/** One journal record as `history.read` returns it; only messages are imported. */
export type JournalReadRecord = {
  seq: number;
  kind: string;
  turnId: string;
  role?: "user" | "assistant" | "toolResult";
  hidden?: boolean;
  payload?: unknown;
  /** A card record's card. */
  card?: unknown;
  /** A prompt row's client message id. */
  clientMsgId?: string;
};

/** A computer's cloud agent's brief or message (`pi-cloud-agents`): the agent's, not the conversation's. */
const AGENT_OPERATION = /^pia:/;

/** The conversation's journal, as this computer reaches it. */
export type DesktopJournal = {
  /** This computer, which a cloud agent's report card names when it is for it. */
  deviceId: string;
  /** Where the conversation's bounded model context starts, for a first import. */
  contextStartSeq(): Promise<number>;
  /** Records after `afterSeq`, ascending, a batch at a time. */
  read(afterSeq: number): Promise<{ records: JournalReadRecord[]; complete: boolean }>;
  /** This computer's own mirrored turns and voice lines, which are not imported back. */
  ownTurn(turnId: string): boolean;
  begin(turn: {
    localTurnId: string;
    clientMsgId: string;
    userMessageJson: string;
    hidden: boolean;
    /** Reacquire the lease of a turn a previous process opened, under its owner epoch. */
    adopt?: boolean;
    ownerGeneration?: string;
  }): Promise<{ leaseToken: string; ownerGeneration: string }>;
  finish(turn: {
    localTurnId: string;
    leaseToken: string;
    ownerGeneration: string;
    records: Array<{ ordinal: number; role: "assistant" | "toolResult"; payloadJson: string }>;
    phase: "completed" | "failed" | "canceled";
    notice?: string;
  }): Promise<void>;
  /** What a voice call said, outside any turn. */
  appendVoice(append: { appendId: string; role: "user" | "assistant"; payloadJson: string; hidden: boolean }): Promise<void>;
};

export type JournalMirror = {
  /** Import what other writers journaled since the last import. */
  importNow(): Promise<void>;
  /** Mirror what the transcript has added since the last sync. */
  sync(): void;
  stop(): Promise<void>;
};

const PAGE = 100;
/** Events after which the transcript may have something to mirror. */
const MIRRORED_EVENTS = new Set(["entry_appended", "message_end", "tool_execution_end", "run_end"]);

/** A report of this computer's cloud agent, or that one of its messages settled without one. */
const reportFor = (record: JournalReadRecord, deviceId: string): JournalAgentReport | undefined => {
  const card = record.card as
    | { type?: unknown; reportFor?: unknown; threadId?: unknown; requestId?: unknown; text?: unknown; settled?: unknown }
    | undefined;
  if (record.kind !== "card" || card?.type !== "agent-report" || card.reportFor !== deviceId) return undefined;
  if (typeof card.threadId !== "string" || typeof card.requestId !== "string") return undefined;
  const text = card.settled === true ? undefined : typeof card.text === "string" && card.text ? card.text : undefined;
  if (text === undefined && card.settled !== true) return undefined;
  return {
    seq: record.seq,
    report: { threadId: card.threadId, requestId: card.requestId, ...(text === undefined ? {} : { text }) },
  };
};

const asJournalMessage = (record: JournalReadRecord): JournalMessage | undefined => {
  if (record.kind !== "message" || !record.role) return undefined;
  const message = record.payload as Message | { $spill?: true } | null;
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== record.role) {
    return undefined;
  }
  return { seq: record.seq, turnId: record.turnId, role: record.role, hidden: record.hidden === true, message };
};

export async function journalMirror(args: {
  harness: Harness;
  root: Conversation;
  journal: DesktopJournal;
  report: (error: unknown) => void;
  context: Context;
}): Promise<JournalMirror> {
  const { harness, root, journal, report, context } = args;
  /** Turns whose lease this process holds (or re-adopted after a restart). */
  const held = new Set<string>();
  let running = false;
  let again = false;
  let stopped = false;

  const doc = async (): Promise<Readonly<JournalSyncState>> =>
    (await harness.snapshot(JournalSyncDoc, root.id, context)) ?? {};
  const save = (patch: (state: JournalSyncState) => void) =>
    harness.commit(async (tx) => {
      patch(await tx.doc(JournalSyncDoc, root.id));
      return undefined;
    }, context);

  const importNow = async () => {
    const imported = (await doc()).importedSeq;
    let after: number = imported ?? (await journal.contextStartSeq()) - 1;
    // A first import starts at a prompt: a window may open mid-turn, on tool
    // results whose calls it no longer holds.
    let atPrompt = imported !== undefined;
    for (;;) {
      const page = await journal.read(after);
      const messages: (JournalMessage | JournalAgentReport)[] = [];
      for (const record of page.records) {
        const report = reportFor(record, journal.deviceId);
        if (report) {
          messages.push(report);
          continue;
        }
        if (journal.ownTurn(record.turnId) || AGENT_OPERATION.test(record.clientMsgId ?? "")) continue;
        const message = asJournalMessage(record);
        if (!message) continue;
        if (!atPrompt && message.role !== "user") continue;
        atPrompt = true;
        messages.push(message);
      }
      const through: number = page.records.at(-1)?.seq ?? after;
      await importJournal(harness, root, messages, through, context);
      if (page.complete || through <= after) return;
      after = through;
    }
  };

  /** End a journal turn with what it produced; a refusal is reported and the turn let go. */
  const finishTurn = (open: Readonly<JournalOpenTurn>) =>
    finishWith(open).catch((error: unknown) => {
      held.delete(open.localTurnId);
      report(error);
    });

  const finishWith = async (open: Readonly<JournalOpenTurn>) => {
    const entries: EntryRecord[] = [];
    for (const id of open.entries) {
      const entry = await harness.commit(async (tx) => tx.entry(id as EntryId), context);
      if (entry?.model?.[0]) entries.push(entry);
    }
    const messages = entries.map((entry) => entry.model![0]!);
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    const stop = last?.role === "assistant" ? last.stopReason : undefined;
    await journal.finish({
      localTurnId: open.localTurnId,
      leaseToken: open.leaseToken,
      ownerGeneration: open.ownerGeneration,
      records: messages.map((message, ordinal) => ({
        ordinal,
        role: message.role === "assistant" ? "assistant" : "toolResult",
        payloadJson: JSON.stringify(message),
      })),
      ...(stop === "error"
        ? { phase: "failed" as const, notice: "Stella couldn't answer this message." }
        : stop === "aborted"
          ? { phase: "canceled" as const }
          : { phase: "completed" as const }),
    });
    held.delete(open.localTurnId);
  };

  const mirror = async () => {
    const state = await doc();
    const syncId = state.syncId ?? randomUUID();
    let mirrored = state.mirrored ?? 0;
    let open: JournalOpenTurn | undefined = state.open && { ...state.open, entries: [...state.open.entries] };
    // A turn a previous process opened: take its lease back, or let it go
    // when the journal no longer has it.
    if (open && !held.has(open.localTurnId)) {
      const turn = open;
      const userEntry = await harness.commit(async (tx) => tx.entry(Number(turn.localTurnId.split(":").at(-1)) as EntryId), context);
      const user = userEntry?.model?.[0];
      const ack =
        user?.role === "user"
          ? await journal
              .begin({
                localTurnId: turn.localTurnId,
                clientMsgId: turn.localTurnId,
                userMessageJson: JSON.stringify(piJournalUserMessage(user as PiUserMessage).message),
                hidden: piJournalUserMessage(user as PiUserMessage).hidden,
                adopt: true,
                ownerGeneration: turn.ownerGeneration,
              })
              .catch((error: unknown) => {
                report(error);
                return undefined;
              })
          : undefined;
      if (ack) {
        open = { ...turn, leaseToken: ack.leaseToken };
        held.add(turn.localTurnId);
      } else {
        open = undefined;
      }
    }
    for (;;) {
      const page = await harness.commit(
        async (tx) => (await tx.scanEntries({ conversationId: root.id, minEntryId: (mirrored + 1) as EntryId, order: "ascending" }, PAGE)).items,
        context,
      );
      for (const entry of page) {
        const message = entry.model?.[0];
        if (message && journalSeqOf(entry) === undefined) {
          const said = message as Message & { source?: string; stella?: { hidden?: true } };
          if (said.source === "voice" && (message.role === "user" || message.role === "assistant")) {
            const journaled = message.role === "user" ? piJournalUserMessage(message as PiUserMessage) : undefined;
            await journal.appendVoice({
              appendId: `pi:${syncId}:${entry.id}`,
              role: message.role,
              payloadJson: JSON.stringify(journaled?.message ?? message),
              hidden: journaled?.hidden ?? said.stella?.hidden === true,
            });
          } else if (entry.kind === "pi.user" && message.role === "user") {
            if (open) await finishTurn(open);
            const journaled = piJournalUserMessage(message as PiUserMessage);
            const localTurnId = `pi:${syncId}:${entry.id}`;
            // The writer retries what can succeed; a refusal is final, and the
            // turn stays on this computer only.
            const ack = await journal
              .begin({
                localTurnId,
                clientMsgId: localTurnId,
                userMessageJson: JSON.stringify(journaled.message),
                hidden: journaled.hidden,
              })
              .catch((error: unknown) => {
                report(error);
                return undefined;
              });
            if (ack) held.add(localTurnId);
            open = ack
              ? { localTurnId, leaseToken: ack.leaseToken, ownerGeneration: ack.ownerGeneration, entries: [] }
              : undefined;
          } else if (open && (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result")) {
            open = { ...open, entries: [...open.entries, entry.id] };
          }
        }
        mirrored = entry.id;
      }
      const turn = open;
      await save((current) => {
        current.syncId = syncId;
        current.mirrored = mirrored;
        if (turn) current.open = turn;
        else delete current.open;
      });
      if (page.length < PAGE) break;
    }
    // The orchestrator went idle: the open turn is over.
    if (open && !(await harness.snapshot(LiveDoc, root.id, context))?.run) {
      await finishTurn(open);
      await save((current) => {
        delete current.open;
      });
    }
  };

  const sync = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        again = false;
        await mirror().catch(report);
      } while (again && !stopped);
      running = false;
    })();
  };

  const stream: AgentEventStream = await watchEvents(harness, root.id, context);
  stream.start(async (events) => {
    if ((events as Array<{ type: string }>).some((event) => MIRRORED_EVENTS.has(event.type))) sync();
  });
  sync();

  return {
    importNow,
    sync,
    async stop() {
      stopped = true;
      await stream.stop().catch(() => undefined);
    },
  };
}
