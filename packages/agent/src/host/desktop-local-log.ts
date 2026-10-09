/**
 * A conversation kept on this computer, on pi-durable and on the agent loops'
 * chat log at once. The log is what the Claude Code engine answers from and
 * what the app shows under it, so the user can move between engines and keep
 * one conversation: what pi's turns said (the user's messages, Stella's
 * replies) is written into the log as it lands, and what the log gained
 * meanwhile (Claude Code's turns) is written into the transcript before pi
 * answers again.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  defineDoc,
  InboxDoc,
  LiveDoc,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type EntryDraft,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable";
import { piMessageText, piUserHidden, piUserView, type PiUserMessage } from "@stella/contracts/pi-chat";
import { splitReplyRefs } from "@stella/contracts/reply-refs";

/** One message the log holds that pi did not write. */
export type LocalLogMessage = { id: string; seq: number; role: "user" | "assistant"; text: string; timestamp: number };

/** The conversation's chat log, as this computer keeps it. */
export type DesktopLocalLog = {
  /**
   * Messages after `afterSeq`, ascending, at most `limit` rows read: the ones
   * pi did not write, and the last row read (`throughSeq`).
   */
  read(afterSeq: number, limit: number): Promise<{ messages: LocalLogMessage[]; throughSeq: number; complete: boolean }>;
  /** One of pi's messages, written once per `key`. */
  write(message: {
    key: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    /** An answer's user message (its `key`). */
    replyTo?: string;
    /** An answer Stella went on from with a tool call. */
    followedByToolCall?: boolean;
  }): Promise<void>;
};

export type LocalLogMirror = {
  /** Write what the log gained since the last import into the transcript. */
  importNow(): Promise<void>;
  stop(): Promise<void>;
};

/** How far each direction got: the log's last row imported, pi's last entry written to the log. */
const LocalLogSyncDoc = defineDoc<{ importedSeq?: number; mirrored?: number; replyTo?: string }>({
  kind: "stella.local-log",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

const PAGE = 200;
/** Log rows imported per commit. */
const IMPORT_PAGE = 1000;
/** A log message to import, and its text. */
type Imported = { message: LocalLogMessage; text: string };
/** Events after which the transcript may have something for the log. */
const MIRRORED_EVENTS = new Set(["entry_appended", "message_end", "run_end"]);

/** What the log's message was written as: kept on the entry, so it is never written back. */
const fromLog = (entry: { data?: unknown }): boolean =>
  typeof (entry.data as { localLog?: unknown } | undefined)?.localLog === "string";

/**
 * A reply written into a transcript without a model call (the onboarding
 * greeting, a reply from the chat log). It carries an empty usage: pi reads
 * the last reply's usage to size the context, and the usage dashboard skips a
 * call that cost nothing.
 */
export const writtenReply = (text: string, timestamp: number, model: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "stella",
    provider: "stella",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  }) as AssistantMessage;

export async function localLogMirror(args: {
  harness: Harness;
  root: Conversation;
  log: DesktopLocalLog;
  report: (error: unknown) => void;
  context: Context;
}): Promise<LocalLogMirror> {
  const { harness, root, log, report, context } = args;
  let stopped = false;

  const doc = async () => (await harness.snapshot(LocalLogSyncDoc, root.id, context)) ?? {};
  const save = (patch: (state: { importedSeq?: number; mirrored?: number; replyTo?: string }) => void) =>
    harness.commit(async (tx) => {
      patch(await tx.doc(LocalLogSyncDoc, root.id));
      return undefined;
    }, context);

  /** The entry a log message is written as. */
  const entryOf = ({ message, text }: Imported): EntryDraft => ({
    kind: message.role === "user" ? "pi.user" : "pi.assistant",
    model: [
      message.role === "user"
        ? ({ role: "user", content: [{ type: "text", text }], timestamp: message.timestamp } as Message)
        : writtenReply(text, message.timestamp, "legacy"),
    ],
    data: { localLog: message.id },
  });
  /** The request a message goes through pi's inbox under, so it is never written twice. */
  const requestOf = (message: LocalLogMessage) => `legacy:${message.id}`;

  /**
   * A page of the log written into the transcript in one commit, with how far
   * the import got: a crash keeps both or neither, so each row is written
   * once. False, writing nothing, while pi answers or has writes queued: a
   * run reads the transcript between its steps, so those go through its inbox.
   */
  const importPage = (page: Imported[], through: number) =>
    harness.commit(async (tx) => {
      // A page that went through the inbox (as every page did in older
      // builds) and was cut short: each message it wrote has a request, its
      // first message first.
      const written = new Set<string>();
      if (page[0] && (await tx.submissionByRequest(root.id, requestOf(page[0].message)))) {
        for (const { message } of page) {
          if (await tx.submissionByRequest(root.id, requestOf(message))) written.add(message.id);
        }
      }
      const last = (await tx.scanEntries({ conversationId: root.id, order: "descending" }, 1)).items[0]?.id ?? 0;
      if ((await tx.doc(LiveDoc, root.id)).run !== undefined || (await tx.doc(InboxDoc, root.id)).items.length > 0) {
        return false;
      }
      const state = await tx.doc(LocalLogSyncDoc, root.id);
      const imported = state.importedSeq ?? -1;
      let newest: number = last;
      for (const item of page) {
        if (item.message.seq <= imported || written.has(item.message.id)) continue;
        newest = (await tx.appendEntry(root.id, entryOf(item))).id;
      }
      // Nothing of pi's waits for the log, so what came from it needs no pass.
      if ((state.mirrored ?? 0) >= last) state.mirrored = newest;
      state.importedSeq = Math.max(imported, through);
      return true;
    }, context);

  /** The log imported through `through`. */
  const advance = (through: number) =>
    save((state) => {
      state.importedSeq = Math.max(state.importedSeq ?? -1, through);
    });

  /** A page through pi's inbox: placed at its run's next step, one write each. */
  const submitPage = async (page: Imported[], through: number) => {
    for (const item of page) {
      await root.submit({ type: "write", requestId: requestOf(item.message), entry: entryOf(item) }, context);
    }
    await advance(through);
  };

  let importing: Promise<void> | undefined;
  const importOnce = async () => {
    let after = (await doc()).importedSeq ?? -1;
    for (;;) {
      const read = await log.read(after, IMPORT_PAGE);
      if (read.throughSeq > after) {
        const page = read.messages.flatMap((message) => {
          const text = message.text.trim();
          return text ? [{ message, text }] : [];
        });
        // Most often only pi's own messages, written back: nothing to import.
        if (page.length === 0) await advance(read.throughSeq);
        else if (!(await importPage(page, read.throughSeq))) await submitPage(page, read.throughSeq);
      }
      if (read.complete || read.throughSeq <= after) break;
      after = read.throughSeq;
    }
  };
  /** One import at a time; a caller during one waits for it. */
  const importNow = () =>
    (importing ??= importOnce().finally(() => {
      importing = undefined;
    }));

  // A conversation from before its turns were mirrored starts from here:
  // what it already holds came from the log, or stays on pi.
  if ((await doc()).mirrored === undefined) {
    const last = await harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: root.id, order: "descending" }, 1)).items[0],
      context,
    );
    await save((current) => {
      current.mirrored = last?.id ?? 0;
    });
  }

  let running = false;
  let again = false;
  const mirrorOnce = async () => {
    const state = await doc();
    let replyTo = state.replyTo;
    let mirrored = state.mirrored ?? 0;
    for (;;) {
      const page = await harness.commit(
        async (tx) =>
          (await tx.scanEntries({ conversationId: root.id, minEntryId: (mirrored + 1) as EntryId, order: "ascending" }, PAGE)).items,
        context,
      );
      for (const entry of page) {
        const message = entry.model?.[0];
        if (message && !fromLog(entry)) {
          const key = `${root.id}:${entry.id}`;
          if (entry.kind === "pi.user" && message.role === "user") {
            const { text } = piUserView(message as PiUserMessage);
            // An agent's report or note and a prompt the app sent are not the user's words.
            if (text.trim() && !piUserHidden(message as PiUserMessage)) {
              await log.write({ key, role: "user", text: text.trim(), timestamp: message.timestamp });
              replyTo = key;
            }
          } else if (entry.kind === "pi.assistant" && message.role === "assistant") {
            const text = splitReplyRefs(piMessageText(message)).text.trim();
            if (text) {
              await log.write({
                key,
                role: "assistant",
                text,
                timestamp: message.timestamp,
                ...(replyTo ? { replyTo } : {}),
                ...(message.content.some((part) => part.type === "toolCall") ? { followedByToolCall: true } : {}),
              });
            }
          }
        }
        mirrored = entry.id;
      }
      const through = mirrored;
      const reply = replyTo;
      await save((current) => {
        // An import meanwhile may have moved it past what it wrote.
        current.mirrored = Math.max(current.mirrored ?? 0, through);
        if (reply) current.replyTo = reply;
      });
      if (page.length < PAGE) break;
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
        await mirrorOnce().catch(report);
      } while (again && !stopped);
      running = false;
    })();
  };

  // What the log gained while the conversation was closed, all of a long
  // one's history on its first open, comes in before anything watches the
  // transcript: a watched transcript's view is copied per entry appended.
  await importNow().catch(report);

  const stream: AgentEventStream = await watchEvents(harness, root.id, context);
  stream.start(async (events) => {
    if ((events as Array<{ type: string }>).some((event) => MIRRORED_EVENTS.has(event.type))) sync();
  });
  // What a previous process added and never wrote to the log.
  sync();

  return {
    importNow,
    async stop() {
      stopped = true;
      await stream.stop().catch(() => undefined);
    },
  };
}
