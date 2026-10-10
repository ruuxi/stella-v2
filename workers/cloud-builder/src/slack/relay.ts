/**
 * The conversation object's Slack side. A conversation started from Slack is
 * bound to its thread (`bind`, called by `events.ts` before each turn), and
 * from then on everything it commits is mirrored there:
 *
 * - Stella's replies, as they are journaled, including the ones that answer
 *   an agent's completion hours later;
 * - one progress message per turn, edited in place: the tools it runs and the
 *   background agents it starts, each ticking to done, with a Stop button
 *   while the turn runs;
 * - files the turn's agents produce, uploaded into the thread;
 * - the 👀 reaction on the request, removed when the turn ends, and a notice
 *   when a turn fails or is stopped.
 *
 * Delivery is best effort and ordered: one promise chain per object, every
 * Slack call caught. A conversation that was never bound answers `observe`
 * after one storage read and then never again.
 */

import type { JournalRecord } from "../conversation-types.js";
import { unwrapRpc } from "../owner-store/errors.js";
import {
  slackCall,
  slackTry,
  SlackApiError,
  splitForSlack,
  uploadSlackFile,
} from "./api.js";
import {
  splitReplyRefs,
  stripMessageRefTag,
} from "@stella/contracts/reply-refs";
import { toolLabel } from "./format.js";
import { STOP_ACTION, stopValue } from "./interactivity.js";
import { loadInstallation, type SlackInstallation } from "./store.js";

export type SlackRelayBinding = {
  teamId: string;
  channelId: string;
  /** The thread's root; null for a DM, whose replies are top level. */
  threadTs: string | null;
  ownerId: string;
  requesterUserId: string;
  shared: boolean;
};

type Line = {
  key: string;
  text: string;
  state: "running" | "done" | "error";
  count?: number;
};

type TurnState = {
  triggerTs?: string;
  reactionCleared?: boolean;
  progressTs?: string;
  lines: Line[];
  phase: "running" | "completed" | "failed" | "canceled";
  /** A turn no Slack message asked for (an agent's report, a schedule) reports into this one. */
  hostTurnId?: string;
  startedAt?: number;
  /** Stella has said something in the thread for this request. */
  acked?: boolean;
  /** Someone pressed Stop; the request ends here whatever still reports. */
  stopped?: boolean;
  /** Woken by an agent's progress note rather than its report: brief replies stay in the app. */
  noteWake?: boolean;
  updatedAt: number;
};

const BINDING_KEY = "slack:binding";
const TRIGGERS_KEY = "slack:triggers";
const TURNS_KEY = "slack:turns";
const AGENTS_KEY = "slack:agents";
const CURRENT_KEY = "slack:current";
const MAX_TRACKED = 30;
const MAX_LINES = 14;
const RENDER_INTERVAL_MS = 1_200;
const TOKEN_CACHE_MS = 5 * 60_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const STALE_TURN_MS = 20 * 60_000;
const SETTLE_DELAY_MS = 6_000;
/** Give Stella's first words a head start over the checklist. */
const PROGRESS_GRACE_MS = 25_000;
const STALE_AGENT_MS = 3 * 60 * 60_000;
/** A reply to an agent's progress note this short is chatter, not a result. */
const NOTE_REPLY_MIN_CHARS = 500;
const AGENT_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "agent_status",
  "pause_agent",
]);

const errorText = (error: unknown): string =>
  error instanceof SlackApiError
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error);

const trimRecord = <T>(
  record: Record<string, T>,
  max: number,
): Record<string, T> => {
  const keys = Object.keys(record);
  if (keys.length <= max) return record;
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - max)) kept[key] = record[key]!;
  return kept;
};

const assistantText = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const message = payload as { $spill?: unknown; content?: unknown };
  if (message.$spill)
    return "_This reply is too long for Slack. Open it in Stella to read it._";
  let text: string | null = null;
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text);
    text = parts.length ? parts.join("\n\n") : null;
  }
  return text === null
    ? null
    : forSlack(stripMessageRefTag(withoutRefs(splitReplyRefs(text).text)));
};

/** A trailing `refs` fence the model glued to its last line, closed or not. */
const withoutRefs = (text: string): string =>
  text.replace(/\s*`{3}[ \t]*refs\b[^`]*(?:`{3})?\s*$/u, "");

/**
 * Links Slack can't open (drive and workspace paths, which Stella's own apps
 * turn into file chips) are dropped when they stand on a line of their own,
 * since the file itself is uploaded into the thread, and become their label
 * inside a sentence.
 */
const NON_WEB_LINK = /\[([^\]\n]+)\]\((?!https?:|mailto:)([^)\s]+)\)/iu;
const forSlack = (text: string): string =>
  text
    .split("\n")
    .filter((line) => {
      const match = NON_WEB_LINK.exec(line);
      if (!match) return true;
      const rest = line.replace(match[0], "").replace(/[-*•:.!()\s]/gu, "");
      return rest.length > 40;
    })
    .join("\n")
    .replace(
      new RegExp(NON_WEB_LINK.source, "giu"),
      (_whole, label: string) => label,
    )
    .trim();

export class SlackRelay {
  private binding: SlackRelayBinding | null | undefined;
  private chain: Promise<void> = Promise.resolve();
  private install: { value: SlackInstallation; at: number } | null = null;
  private turns: Record<string, TurnState> | null = null;
  private lastRender = new Map<string, number>();
  private renderPending = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Cloudflare.Env,
    private readonly conversationId: () => string,
    private readonly waitUntil: (work: Promise<unknown>) => void,
  ) {}

  /** Where this conversation's replies go, and which Slack message asked. */
  async bind(
    input: SlackRelayBinding & { clientMsgId: string; triggerTs: string },
  ): Promise<void> {
    const binding: SlackRelayBinding = {
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      ownerId: input.ownerId,
      requesterUserId: input.requesterUserId,
      shared: input.shared,
    };
    const triggers = trimRecord(
      {
        ...((await this.storage.get<Record<string, string>>(TRIGGERS_KEY)) ??
          {}),
        [input.clientMsgId]: input.triggerTs,
      },
      MAX_TRACKED,
    );
    await this.storage.put({
      [BINDING_KEY]: binding,
      [TRIGGERS_KEY]: triggers,
    });
    this.binding = binding;
  }

  observe(record: JournalRecord): void {
    if (this.binding === null) return;
    this.enqueue(() => this.handleRecord(record));
  }

  tool(
    turnId: string,
    toolCallId: string,
    name: string,
    phase: "start" | "end",
    isError?: boolean,
  ): void {
    if (this.binding === null || AGENT_TOOLS.has(name)) return;
    this.enqueue(async () => {
      const host = await this.hostOf(turnId);
      if (!host) return;
      const state = await this.turn(host);
      const label = toolLabel(name);
      const key = `tool:${label}`;
      let line = state.lines.find((entry) => entry.key === key);
      if (phase === "start") {
        if (!line) {
          line = { key, text: label, state: "running", count: 0 };
          state.lines.push(line);
        }
        line.count = (line.count ?? 0) + 1;
        line.state = "running";
      } else if (line) {
        line.state = isError && line.state !== "done" ? "error" : "done";
      }
      await this.saveTurns();
      this.scheduleRender(host);
    });
  }

  /** Agents a Slack request started that are still working. */
  async runningAgentIds(): Promise<string[]> {
    const turns = await this.loadTurns();
    const ids = new Set<string>();
    for (const state of Object.values(turns)) {
      for (const line of state.lines) {
        if (line.key.startsWith("agent:") && line.state === "running")
          ids.add(line.key.slice("agent:".length));
      }
    }
    return [...ids];
  }

  /** Stop pressed: the request reads Stopped, once, naming who stopped it. */
  stopped(hostTurnId: string, slackUserId: string): void {
    this.enqueue(async () => {
      const state = await this.turn(hostTurnId);
      if (state.stopped) return;
      state.stopped = true;
      for (const line of state.lines) {
        if (line.state === "running") {
          line.state = "error";
          if (line.key.startsWith("agent:"))
            line.text = `${line.text} (stopped)`;
        }
      }
      await this.saveTurns();
      this.scheduleRender(hostTurnId);
      await this.postText(`:octagonal_sign: Stopped by <@${slackUserId}>.`);
      this.settleSoon();
    });
  }

  private enqueue(work: () => Promise<void>): void {
    const next = this.chain
      .then(async () => {
        if (this.binding === undefined) {
          this.binding =
            (await this.storage.get<SlackRelayBinding>(BINDING_KEY)) ?? null;
        }
        if (this.binding === null) return;
        await work();
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "slack_relay_failed",
            message: errorText(error),
          }),
        );
      });
    this.chain = next;
    this.waitUntil(next);
  }

  private async token(): Promise<SlackInstallation | null> {
    if (this.install && Date.now() - this.install.at < TOKEN_CACHE_MS)
      return this.install.value;
    const value = await loadInstallation(this.env, this.binding!.teamId);
    this.install = value ? { value, at: Date.now() } : null;
    return value;
  }

  private async loadTurns(): Promise<Record<string, TurnState>> {
    this.turns ??=
      (await this.storage.get<Record<string, TurnState>>(TURNS_KEY)) ?? {};
    return this.turns;
  }

  private async turn(turnId: string): Promise<TurnState> {
    const turns = await this.loadTurns();
    const existing = turns[turnId];
    if (existing) return existing;
    const created: TurnState = {
      lines: [],
      phase: "running",
      updatedAt: Date.now(),
    };
    turns[turnId] = created;
    return created;
  }

  /** The Slack request a turn reports into: its own, or the latest one. */
  private async hostOf(turnId: string): Promise<string | null> {
    const turns = await this.loadTurns();
    const own = turns[turnId];
    if (own?.triggerTs) return turnId;
    if (own?.hostTurnId) return own.hostTurnId;
    return (await this.storage.get<string>(CURRENT_KEY)) ?? null;
  }

  private async saveTurns(): Promise<void> {
    if (!this.turns) return;
    this.turns = trimRecord(this.turns, MAX_TRACKED);
    await this.storage.put(TURNS_KEY, this.turns);
  }

  /** Any turn still running, or any agent a Slack request started still working. */
  private async busy(): Promise<{
    runningTurnId: string | null;
    agentsRunning: boolean;
  }> {
    const turns = await this.loadTurns();
    const now = Date.now();
    let runningTurnId: string | null = null;
    let agentsRunning = false;
    for (const [turnId, state] of Object.entries(turns)) {
      if (state.phase === "running" && now - state.updatedAt < STALE_TURN_MS)
        runningTurnId = turnId;
      if (
        !state.stopped &&
        now - state.updatedAt < STALE_AGENT_MS &&
        state.lines.some(
          (line) => line.key.startsWith("agent:") && line.state === "running",
        )
      ) {
        agentsRunning = true;
      }
    }
    return { runningTurnId, agentsRunning };
  }

  private where(): { channel: string; thread_ts?: string } {
    const binding = this.binding!;
    return {
      channel: binding.channelId,
      ...(binding.threadTs ? { thread_ts: binding.threadTs } : {}),
    };
  }

  private async handleRecord(record: JournalRecord): Promise<void> {
    if (record.kind === "message") {
      if (
        record.role === "user" &&
        record.hidden &&
        record.clientMsgId?.startsWith("agent-note:")
      ) {
        const state = await this.turn(record.turnId);
        state.noteWake = true;
        await this.saveTurns();
        return;
      }
      if (record.role === "user" && record.clientMsgId) {
        const triggers =
          (await this.storage.get<Record<string, string>>(TRIGGERS_KEY)) ?? {};
        const triggerTs = triggers[record.clientMsgId];
        if (!triggerTs) return;
        const state = await this.turn(record.turnId);
        state.triggerTs = triggerTs;
        state.startedAt = Date.now();
        state.updatedAt = Date.now();
        await this.saveTurns();
        await this.storage.put(CURRENT_KEY, record.turnId);
        const install = await this.token();
        if (install && this.binding!.threadTs) {
          await slackTry(install.botToken, "assistant.threads.setStatus", {
            channel_id: this.binding!.channelId,
            thread_ts: this.binding!.threadTs,
            status: "is working on it…",
          });
        }
        return;
      }
      if (record.role === "assistant" && !record.hidden) {
        const text = assistantText(record.payload)?.trim();
        if (!text) return;
        const host = await this.hostOf(record.turnId);
        const turns = await this.loadTurns();
        if (host && turns[host]?.stopped && !turns[record.turnId]?.triggerTs)
          return;
        if (
          turns[record.turnId]?.noteWake &&
          text.length < NOTE_REPLY_MIN_CHARS
        )
          return;
        await this.postText(text);
        if (host) {
          const state = await this.turn(host);
          if (!state.acked) {
            state.acked = true;
            await this.saveTurns();
            if (!state.progressTs && state.lines.length)
              this.scheduleRender(host);
          }
        }
      }
      return;
    }
    if (record.kind === "card") {
      const card = record.card;
      if (card.type === "agent-lifecycle")
        await this.agentEvent(record.turnId, card.event);
      if (card.type === "files") await this.uploadFiles(card.files);
      return;
    }
    if (record.kind === "turn") {
      if (record.phase === "started") {
        const state = await this.turn(record.turnId);
        state.phase = "running";
        state.updatedAt = Date.now();
        if (!state.triggerTs) {
          const host = await this.hostOf(record.turnId);
          if (host && host !== record.turnId) state.hostTurnId = host;
        }
        await this.saveTurns();
        return;
      }
      await this.finishTurn(record.turnId, record.phase, record.notice);
    }
  }

  private async postText(text: string): Promise<void> {
    const install = await this.token();
    if (!install) return;
    for (const part of splitForSlack(text)) {
      try {
        await slackCall(install.botToken, "chat.postMessage", {
          ...this.where(),
          markdown_text: part,
          unfurl_links: false,
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "slack_markdown_post_failed",
            code: errorText(error),
          }),
        );
        await slackTry(install.botToken, "chat.postMessage", {
          ...this.where(),
          text: part,
          unfurl_links: false,
        });
      }
    }
  }

  private async agentEvent(
    turnId: string,
    event: {
      type: string;
      payload: { agentId: string; description?: string; error?: string };
    },
  ): Promise<void> {
    const agents =
      (await this.storage.get<Record<string, string>>(AGENTS_KEY)) ?? {};
    const key = `agent:${event.payload.agentId}`;
    if (event.type === "agent-started") {
      const host = (await this.hostOf(turnId)) ?? turnId;
      const state = await this.turn(host);
      if (state.stopped) return;
      agents[event.payload.agentId] = host;
      await this.storage.put(AGENTS_KEY, trimRecord(agents, MAX_TRACKED * 2));
      const existing = state.lines.find((line) => line.key === key);
      if (existing) existing.state = "running";
      else
        state.lines.push({
          key,
          text: `Agent: ${event.payload.description ?? "background work"}`,
          state: "running",
        });
      state.updatedAt = Date.now();
      await this.saveTurns();
      this.scheduleRender(host);
      return;
    }
    if (event.type === "agent-progress") return;
    const host =
      agents[event.payload.agentId] ?? (await this.hostOf(turnId)) ?? turnId;
    const state = await this.turn(host);
    const line = state.lines.find((entry) => entry.key === key);
    if (!line) return;
    if (state.stopped) return;
    line.state = event.type === "agent-completed" ? "done" : "error";
    if (event.type === "agent-canceled") line.text = `${line.text} (stopped)`;
    if (event.type === "agent-failed" && event.payload.error)
      line.text = `${line.text} (${event.payload.error.slice(0, 80)})`;
    await this.saveTurns();
    this.scheduleRender(host);
    this.settleSoon();
  }

  private async finishTurn(
    turnId: string,
    phase: string,
    notice?: string,
  ): Promise<void> {
    const state = await this.turn(turnId);
    state.phase =
      phase === "completed"
        ? "completed"
        : phase === "canceled"
          ? "canceled"
          : "failed";
    state.updatedAt = Date.now();
    const host = (await this.hostOf(turnId)) ?? turnId;
    const hostState = await this.turn(host);
    for (const line of hostState.lines) {
      if (line.state === "running" && line.key.startsWith("tool:"))
        line.state = phase === "completed" ? "done" : "error";
    }
    await this.saveTurns();
    if (hostState.progressTs) this.scheduleRender(host);
    if (phase === "canceled") {
      if (!hostState.stopped) await this.postText(":octagonal_sign: Stopped.");
    } else if (phase !== "completed" && !hostState.stopped) {
      await this.postText(
        `:warning: ${notice?.trim() || "Stella couldn't finish this one. Try again in a moment."}`,
      );
    }
    this.settleSoon();
  }

  /** An agent's report starts its wake turn a moment after the agent ends; wait for it. */
  private settleSoon(): void {
    this.waitUntil(
      scheduler
        .wait(SETTLE_DELAY_MS)
        .then(() => this.enqueue(() => this.settleIfIdle())),
    );
  }

  /** Nothing left running: the 👀 come off every request it answered. */
  private async settleIfIdle(): Promise<void> {
    const { runningTurnId, agentsRunning } = await this.busy();
    if (runningTurnId || agentsRunning) return;
    const install = await this.token();
    if (!install) return;
    const turns = await this.loadTurns();
    let changed = false;
    for (const [turnId, state] of Object.entries(turns)) {
      if (!state.triggerTs || state.reactionCleared) continue;
      await slackTry(install.botToken, "reactions.remove", {
        channel: this.binding!.channelId,
        timestamp: state.triggerTs,
        name: "eyes",
      });
      state.reactionCleared = true;
      changed = true;
      if (state.progressTs) this.scheduleRender(turnId);
    }
    if (changed) await this.saveTurns();
  }

  private scheduleRender(turnId: string): void {
    const since = Date.now() - (this.lastRender.get(turnId) ?? 0);
    if (since >= RENDER_INTERVAL_MS) {
      this.enqueue(() => this.render(turnId));
      return;
    }
    if (this.renderPending.has(turnId)) return;
    this.renderPending.add(turnId);
    const later = scheduler.wait(RENDER_INTERVAL_MS - since).then(() => {
      this.renderPending.delete(turnId);
      this.enqueue(() => this.render(turnId));
    });
    this.waitUntil(later);
  }

  private async render(turnId: string): Promise<void> {
    const state = await this.turn(turnId);
    if (!state.lines.length) return;
    const install = await this.token();
    if (!install) return;
    this.lastRender.set(turnId, Date.now());
    const current = (await this.storage.get<string>(CURRENT_KEY)) ?? null;
    const { runningTurnId, agentsRunning } = await this.busy();
    const isCurrent = turnId === current;
    const ownAgentsRunning = state.lines.some(
      (line) => line.key.startsWith("agent:") && line.state === "running",
    );
    let header: string;
    let working = true;
    if (state.stopped) {
      header = ":octagonal_sign: *Stopped*";
      working = false;
    } else if (state.phase === "running") {
      header = ":hourglass_flowing_sand: *Working on it…*";
    } else if (isCurrent ? agentsRunning : ownAgentsRunning) {
      header = ":hourglass_flowing_sand: *Background agents still working…*";
    } else if (isCurrent && runningTurnId) {
      header = ":hourglass_flowing_sand: *Finishing up…*";
    } else {
      working = false;
      header =
        state.phase === "canceled"
          ? ":octagonal_sign: *Stopped*"
          : state.phase === "failed"
            ? ":warning: *Didn't finish*"
            : ":white_check_mark: *Done*";
    }
    const icon = (line: Line): string =>
      line.state === "running" && working
        ? ":small_blue_diamond:"
        : line.state === "error"
          ? ":x:"
          : ":white_check_mark:";
    const lines = state.lines
      .slice(-MAX_LINES)
      .map(
        (line) =>
          `${icon(line)} ${line.text.slice(0, 180)}${(line.count ?? 1) > 1 ? ` (×${line.count})` : ""}`,
      );
    const text = [header, ...lines].join("\n");
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2_900) } },
    ];
    if (working) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: STOP_ACTION,
            text: { type: "plain_text", text: "Stop" },
            style: "danger",
            value: stopValue(this.conversationId(), turnId),
          },
        ],
      });
    }
    if (state.progressTs) {
      await slackTry(install.botToken, "chat.update", {
        channel: this.binding!.channelId,
        ts: state.progressTs,
        text,
        blocks,
      });
      return;
    }
    if (!working) return;
    const waited = Date.now() - (state.startedAt ?? 0);
    if (!state.acked && waited < PROGRESS_GRACE_MS) {
      this.lastRender.delete(turnId);
      this.waitUntil(
        scheduler
          .wait(PROGRESS_GRACE_MS - waited)
          .then(() => this.scheduleRender(turnId)),
      );
      return;
    }
    const posted = await slackTry<{ ok: boolean; ts?: string }>(
      install.botToken,
      "chat.postMessage",
      {
        ...this.where(),
        text,
        blocks,
      },
    );
    if (posted?.ts) {
      state.progressTs = posted.ts;
      await this.saveTurns();
    }
  }

  private async uploadFiles(
    files: Array<{
      path: string;
      name: string;
      sizeBytes: number;
      contentType?: string;
      stored?: boolean;
    }>,
  ): Promise<void> {
    const install = await this.token();
    if (!install) return;
    const binding = this.binding!;
    const gate = this.env.OWNER_GATES.getByName(binding.ownerId);
    const { ownerGeneration } = await gate.snapshot();
    const tooLarge: string[] = [];
    for (const file of files) {
      if (file.stored === false || file.sizeBytes > MAX_UPLOAD_BYTES) {
        tooLarge.push(file.name);
        continue;
      }
      try {
        const located = unwrapRpc(
          await gate.ownerInternal({
            name: "drive.fileUrl",
            args: { path: file.path },
            ownerGeneration,
          }),
        ) as { url: string; contentType?: string };
        const response = await fetch(located.url);
        if (!response.ok) throw new Error(`drive fetch ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        await uploadSlackFile(install.botToken, {
          channelId: binding.channelId,
          ...(binding.threadTs ? { threadTs: binding.threadTs } : {}),
          filename: file.name,
          bytes,
          contentType: file.contentType ?? located.contentType,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "slack_file_upload_failed",
            message: errorText(error),
          }),
        );
        tooLarge.push(file.name);
      }
    }
    if (tooLarge.length) {
      await this.postText(
        `Couldn't attach ${tooLarge.join(", ")} here. Open it in Stella.`,
      );
    }
  }
}
