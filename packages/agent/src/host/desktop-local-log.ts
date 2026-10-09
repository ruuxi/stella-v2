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
import { defineDoc, watchEvents, type AgentEventStream, type Conversation, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { PI_REPORT_RE, piMessageText, piUserView, type PiUserMessage } from "@stella/contracts/pi-chat";
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

  let importing: Promise<void> | undefined;
  const importOnce = async () => {
    let after = (await doc()).importedSeq ?? -1;
    for (;;) {
      const page = await log.read(after, PAGE);
      for (const message of page.messages) {
        const text = message.text.trim();
        if (!text) continue;
        const model =
          message.role === "user"
            ? ({ role: "user", content: [{ type: "text", text }], timestamp: message.timestamp } as Message)
            : writtenReply(text, message.timestamp, "legacy");
        // The id the first import wrote it under, so it is never written twice.
        await root.submit(
          {
            type: "write",
            requestId: `legacy:${message.id}`,
            entry: {
              kind: message.role === "user" ? "pi.user" : "pi.assistant",
              model: [model],
              data: { localLog: message.id },
            },
          },
          context,
        );
      }
      if (page.throughSeq > after) {
        const through = page.throughSeq;
        await save((state) => {
          state.importedSeq = Math.max(state.importedSeq ?? -1, through);
        });
      }
      if (page.complete || page.throughSeq <= after) break;
      after = page.throughSeq;
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
            const said = piMessageText(message as PiUserMessage);
            const { text } = piUserView(message as PiUserMessage);
            // An agent's report and a prompt the app sent are not the user's words.
            if (text.trim() && !PI_REPORT_RE.test(said.trimStart())) {
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
        current.mirrored = through;
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
