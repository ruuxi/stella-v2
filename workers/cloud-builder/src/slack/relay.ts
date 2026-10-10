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
import { slackCall, slackTry, SlackApiError, splitForSlack, uploadSlackFile } from "./api.js";
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

type Line = { key: string; text: string; state: "running" | "done" | "error" };

type TurnState = {
  triggerTs?: string;
  progressTs?: string;
  lines: Line[];
  phase: "running" | "completed" | "failed" | "canceled";
  updatedAt: number;
};

const BINDING_KEY = "slack:binding";
const TRIGGERS_KEY = "slack:triggers";
const TURNS_KEY = "slack:turns";
const AGENTS_KEY = "slack:agents";
const MAX_TRACKED = 30;
const MAX_LINES = 14;
const RENDER_INTERVAL_MS = 1_200;
const TOKEN_CACHE_MS = 5 * 60_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const AGENT_TOOLS = new Set(["spawn_agent", "send_message", "agent_status", "pause_agent"]);

const errorText = (error: unknown): string =>
  error instanceof SlackApiError ? error.code : error instanceof Error ? error.message : String(error);

const trimRecord = <T>(record: Record<string, T>, max: number): Record<string, T> => {
  const keys = Object.keys(record);
  if (keys.length <= max) return record;
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - max)) kept[key] = record[key]!;
  return kept;
};

const assistantText = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const message = payload as { $spill?: unknown; content?: unknown };
  if (message.$spill) return "_This reply is too long for Slack. Open it in Stella to read it._";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"),
    )
    .map((part) => part.text);
  return parts.length ? parts.join("\n\n") : null;
};

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
  async bind(input: SlackRelayBinding & { clientMsgId: string; triggerTs: string }): Promise<void> {
    const binding: SlackRelayBinding = {
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      ownerId: input.ownerId,
      requesterUserId: input.requesterUserId,
      shared: input.shared,
    };
    const triggers = trimRecord(
      { ...((await this.storage.get<Record<string, string>>(TRIGGERS_KEY)) ?? {}), [input.clientMsgId]: input.triggerTs },
      MAX_TRACKED,
    );
    await this.storage.put({ [BINDING_KEY]: binding, [TRIGGERS_KEY]: triggers });
    this.binding = binding;
  }

  observe(record: JournalRecord): void {
    if (this.binding === null) return;
    this.enqueue(() => this.handleRecord(record));
  }

  tool(turnId: string, toolCallId: string, name: string, phase: "start" | "end", isError?: boolean): void {
    if (this.binding === null || AGENT_TOOLS.has(name)) return;
    this.enqueue(async () => {
      const turn = await this.turn(turnId);
      if (turn.phase !== "running") return;
      const key = `tool:${toolCallId}`;
      const line = turn.lines.find((entry) => entry.key === key);
      if (phase === "start" && !line) turn.lines.push({ key, text: toolLabel(name), state: "running" });
      if (phase === "end" && line) line.state = isError ? "error" : "done";
      await this.saveTurns();
      this.scheduleRender(turnId);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    const next = this.chain
      .then(async () => {
        if (this.binding === undefined) {
          this.binding = (await this.storage.get<SlackRelayBinding>(BINDING_KEY)) ?? null;
        }
        if (this.binding === null) return;
        await work();
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: "slack_relay_failed", message: errorText(error) }));
      });
    this.chain = next;
    this.waitUntil(next);
  }

  private async token(): Promise<SlackInstallation | null> {
    if (this.install && Date.now() - this.install.at < TOKEN_CACHE_MS) return this.install.value;
    const value = await loadInstallation(this.env, this.binding!.teamId);
    this.install = value ? { value, at: Date.now() } : null;
    return value;
  }

  private async turn(turnId: string): Promise<TurnState> {
    this.turns ??= (await this.storage.get<Record<string, TurnState>>(TURNS_KEY)) ?? {};
    const existing = this.turns[turnId];
    if (existing) return existing;
    const created: TurnState = { lines: [], phase: "running", updatedAt: Date.now() };
    this.turns[turnId] = created;
    return created;
  }

  private async saveTurns(): Promise<void> {
    if (!this.turns) return;
    this.turns = trimRecord(this.turns, MAX_TRACKED);
    await this.storage.put(TURNS_KEY, this.turns);
  }

  private where(): { channel: string; thread_ts?: string } {
    const binding = this.binding!;
    return { channel: binding.channelId, ...(binding.threadTs ? { thread_ts: binding.threadTs } : {}) };
  }

  private async handleRecord(record: JournalRecord): Promise<void> {
    if (record.kind === "message") {
      if (record.role === "user" && record.clientMsgId) {
        const triggers = (await this.storage.get<Record<string, string>>(TRIGGERS_KEY)) ?? {};
        const triggerTs = triggers[record.clientMsgId];
        if (!triggerTs) return;
        const turn = await this.turn(record.turnId);
        turn.triggerTs = triggerTs;
        await this.saveTurns();
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
        if (text) await this.postText(text);
      }
      return;
    }
    if (record.kind === "card") {
      const card = record.card;
      if (card.type === "agent-lifecycle") await this.agentEvent(record.turnId, card.event);
      if (card.type === "files") await this.uploadFiles(card.files);
      return;
    }
    if (record.kind === "turn") {
      if (record.phase === "started") return;
      await this.finishTurn(record.turnId, record.phase, record.notice);
    }
  }

  private async postText(text: string): Promise<void> {
    const install = await this.token();
    if (!install) return;
    for (const part of splitForSlack(text)) {
      try {
        await slackCall(install.botToken, "chat.postMessage", { ...this.where(), markdown_text: part, unfurl_links: false });
      } catch (error) {
        console.warn(JSON.stringify({ event: "slack_markdown_post_failed", code: errorText(error) }));
        await slackTry(install.botToken, "chat.postMessage", { ...this.where(), text: part, unfurl_links: false });
      }
    }
  }

  private async agentEvent(
    turnId: string,
    event: { type: string; payload: { agentId: string; description?: string; error?: string } },
  ): Promise<void> {
    const agents = (await this.storage.get<Record<string, string>>(AGENTS_KEY)) ?? {};
    const key = `agent:${event.payload.agentId}`;
    if (event.type === "agent-started") {
      const turn = await this.turn(turnId);
      agents[event.payload.agentId] = turnId;
      await this.storage.put(AGENTS_KEY, trimRecord(agents, MAX_TRACKED * 2));
      const existing = turn.lines.find((line) => line.key === key);
      if (existing) existing.state = "running";
      else turn.lines.push({ key, text: `Agent: ${event.payload.description ?? "background work"}`, state: "running" });
      await this.saveTurns();
      this.scheduleRender(turnId);
      return;
    }
    if (event.type === "agent-progress") return;
    const owningTurn = agents[event.payload.agentId] ?? turnId;
    const turn = await this.turn(owningTurn);
    const line = turn.lines.find((entry) => entry.key === key);
    if (!line) return;
    line.state = event.type === "agent-completed" ? "done" : "error";
    if (event.type === "agent-canceled") line.text = `${line.text} (stopped)`;
    await this.saveTurns();
    this.scheduleRender(owningTurn);
  }

  private async finishTurn(turnId: string, phase: string, notice?: string): Promise<void> {
    const turn = await this.turn(turnId);
    turn.phase = phase === "completed" ? "completed" : phase === "canceled" ? "canceled" : "failed";
    for (const line of turn.lines) {
      if (line.state === "running" && line.key.startsWith("tool:")) line.state = phase === "completed" ? "done" : "error";
    }
    await this.saveTurns();
    const install = await this.token();
    if (!install) return;
    if (turn.triggerTs) {
      await slackTry(install.botToken, "reactions.remove", {
        channel: this.binding!.channelId,
        timestamp: turn.triggerTs,
        name: "eyes",
      });
    }
    if (turn.progressTs) await this.render(turnId);
    if (phase === "canceled") await this.postText(":octagonal_sign: Stopped.");
    else if (phase !== "completed") {
      await this.postText(`:warning: ${notice?.trim() || "Stella couldn't finish this one. Try again in a moment."}`);
    }
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
    const turn = await this.turn(turnId);
    if (!turn.lines.length) return;
    const install = await this.token();
    if (!install) return;
    this.lastRender.set(turnId, Date.now());
    const agentsRunning = turn.lines.some((line) => line.key.startsWith("agent:") && line.state === "running");
    const header =
      turn.phase === "running"
        ? ":hourglass_flowing_sand: *Working on it…*"
        : turn.phase === "canceled"
          ? ":octagonal_sign: *Stopped*"
          : turn.phase === "failed"
            ? ":warning: *Didn't finish*"
            : agentsRunning
              ? ":hourglass_flowing_sand: *Background agents still working…*"
              : ":white_check_mark: *Done*";
    const icon = (state: Line["state"]): string =>
      state === "running" ? ":small_blue_diamond:" : state === "done" ? ":white_check_mark:" : ":x:";
    const lines = turn.lines.slice(-MAX_LINES).map((line) => `${icon(line.state)} ${line.text.slice(0, 180)}`);
    const text = [header, ...lines].join("\n");
    const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2_900) } }];
    if (turn.phase === "running") {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: STOP_ACTION,
            text: { type: "plain_text", text: "Stop" },
            value: stopValue(this.conversationId(), turnId),
          },
        ],
      });
    }
    if (turn.progressTs) {
      await slackTry(install.botToken, "chat.update", {
        channel: this.binding!.channelId,
        ts: turn.progressTs,
        text,
        blocks,
      });
      return;
    }
    if (turn.phase !== "running") return;
    const posted = await slackTry<{ ok: boolean; ts?: string }>(install.botToken, "chat.postMessage", {
      ...this.where(),
      text,
      blocks,
    });
    if (posted?.ts) {
      turn.progressTs = posted.ts;
      await this.saveTurns();
    }
  }

  private async uploadFiles(
    files: Array<{ path: string; name: string; sizeBytes: number; contentType?: string; stored?: boolean }>,
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
          await gate.ownerInternal({ name: "drive.fileUrl", args: { path: file.path }, ownerGeneration }),
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
        console.error(JSON.stringify({ event: "slack_file_upload_failed", message: errorText(error) }));
        tooLarge.push(file.name);
      }
    }
    if (tooLarge.length) {
      await this.postText(`Couldn't attach ${tooLarge.join(", ")} here. Open it in Stella.`);
    }
  }
}
