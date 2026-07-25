/**
 * The cloud orchestrator: Stella's delegation-only agent loop running inside
 * a Durable Object — one DO per conversation, one turn at a time, ~token
 * cost only. No sandbox is ever created here; escalation is the spawn tool,
 * which dispatches a general agent into a BuildSession sandbox and returns
 * immediately. Convex owns the canonical transcript; this DO reloads it at
 * every turn start and writes produced messages back at turn end.
 *
 * The loop itself is `packages/runtime`'s agent-core Agent — the same code
 * the desktop ships — with the tool set pinned in code below. Frontmatter
 * allowlists are agent-writable home data on desktop; in the cloud the
 * execution surface is never data-driven.
 */

import { DurableObject } from "cloudflare:workers";
import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { TSchema } from "@sinclair/typebox";
import {
  createCloudRelayModel,
  type CloudEngineSelection,
} from "@stella/executor-cloud/relay-model";
import {
  chunkForAppend,
  pruneAgentHistory,
} from "@stella/executor-cloud/prune-history";

type Env = {
  BUILD_SESSIONS: DurableObjectNamespace;
  BUILDER_SERVICE_SECRET: string;
};

export type ChatTurnRequest = {
  kind: "chat";
  ownerId: string;
  conversationId: string;
  turnId: string;
  sessionId: string;
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
  watchdogMs?: number;
  // Resolved by Convex at dispatch (owner's engine setting + a verified
  // connected credential); absent = the managed Stella relay.
  engine?: CloudEngineSelection;
};

const CHAT_WATCHDOG_MS = 5 * 60_000;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const CLOUD_ORCHESTRATOR_PROMPT = `You are Stella, the user's personal \
agent. You are running in the cloud, so you are always available — no device \
of theirs needs to be awake.

You never execute work yourself: you have no shell, no file access, and no \
code execution. For anything beyond conversation, web lookups, and \
delegation, spawn a background agent with spawn_agent and report back when \
it finishes. Choose the agent's workspace by what the task operates on: \
"drive" is the user's cloud drive (general files and documents — the default \
for new work); "computer" is their local machine, which is not reachable \
from cloud chat yet — say so honestly instead of pretending. When a spawned \
agent finishes you receive an [Agent completed] message with its report; \
relay the substance to the user in your own words.

Be direct, warm, and concise. Answer simple questions yourself instead of \
spawning agents for them.`;

const extractText = (message: AgentMessage): string => {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
};

const SPAWN_AGENT_PARAMETERS = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description:
        "One short, user-friendly sentence summarizing what this work is about.",
    },
    prompt: {
      type: "string",
      description:
        "Detailed instructions for the sub-agent. This is the agent's only context.",
    },
    workspace: {
      type: "string",
      description:
        'Where the work runs, chosen by what the task operates on: "drive" (the user\'s cloud drive — the default), "computer" (their local machine), "project:<name>", "stella", or "app:<slug>". Omit for work with no file subject.',
    },
    model: {
      type: "string",
      description:
        'Optional engine for this one spawn. Omit for the user\'s configured setup. "claude" runs the agent on the user\'s connected Claude subscription; "claude/<model>" pins an engine-native model (e.g. "claude/claude-opus-4-8"). Use ONLY when the user explicitly asked for it.',
    },
  },
  required: ["description", "prompt"],
} as const;

export class OrchestratorSession extends DurableObject<Env> {
  // Serializes turns: Convex can dispatch a wake turn while a user turn is
  // still streaming; the second waits its turn instead of interleaving.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Accepted turns are persisted under queued:* before the 202 goes out;
    // an isolate restart wipes the in-memory queue, so re-enqueue whatever
    // survived — otherwise an accepted turn (and its Convex "running" row)
    // would be silently lost forever.
    this.ctx.blockConcurrencyWhile(async () => {
      const queued = await this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
      });
      for (const turn of queued.values()) this.enqueue(turn);
    });
  }

  private enqueue(turn: ChatTurnRequest): void {
    // Failures surface through the turn's own terminal event; the queue
    // must survive them.
    this.queue = this.queue
      .then(() => this.runTurn(turn))
      .catch(() => undefined);
  }

  private convexPost(
    base: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async event(
    turn: ChatTurnRequest,
    seq: number | "auto",
    kind: string,
    payload: unknown,
    terminal = false,
  ): Promise<void> {
    const response = await this.convexPost(
      turn.convexCallbackBase,
      "/api/cloud/events",
      {
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq,
        kind,
        payload,
        terminal,
      },
    );
    if (!response.ok) {
      throw new Error(`Convex event callback failed with ${response.status}.`);
    }
  }

  async alarm(): Promise<void> {
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (!turn || (await this.ctx.storage.get<boolean>("terminalDelivered")))
      return;
    await this.ctx.storage.put("terminal", true);
    // Marking the turn terminal is not enough — the loop would keep burning
    // metered relay calls for output runTurn will discard.
    this.currentAgent?.abort();
    log("error", "chat_turn_timed_out", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
    });
    try {
      await this.event(
        turn,
        "auto",
        "timeout",
        {
          message:
            "This took longer than expected, so Stella stopped. Try again.",
        },
        true,
      );
      await this.ctx.storage.put("terminalDelivered", true);
    } catch (error) {
      // Single-shot delivery would strand the turn "running" on one
      // transient Convex failure; retry via a re-armed alarm.
      const attempts =
        ((await this.ctx.storage.get<number>("alarmAttempts")) ?? 0) + 1;
      if (attempts <= 5) {
        await this.ctx.storage.put("alarmAttempts", attempts);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      } else {
        await this.ctx.storage.put("terminalDelivered", true);
        log("error", "terminal_delivery_abandoned", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/cancel") {
      const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
      if (turn && !(await this.ctx.storage.get<boolean>("terminal"))) {
        await this.ctx.storage.put("terminal", true);
        this.currentAgent?.abort();
        try {
          await this.event(
            turn,
            "auto",
            "canceled",
            { message: "Stopped." },
            true,
          );
          await this.ctx.storage.put("terminalDelivered", true);
        } catch {
          // Delivery failed; the re-armed alarm retries so the turn cannot
          // stay "running" forever.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      return json({ canceled: true });
    }
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    const turn = (await request.json()) as ChatTurnRequest;
    // Accept immediately and run in the background: holding the dispatch
    // POST open for the whole turn means a mid-turn transport failure makes
    // Convex mark a still-running turn failed. The turn is durable before
    // the 202: persisted under queued:*, with an alarm guaranteed so a
    // restarted DO always wakes to drain the queue.
    await this.ctx.storage.put(`queued:${turn.turnId}`, turn);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(
        Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
      );
    }
    this.enqueue(turn);
    return json({ accepted: true }, 202);
  }

  // The in-flight loop, exposed so /cancel and the alarm can actually stop
  // token burn instead of only marking the turn terminal.
  private currentAgent?: Agent;

  private async runTurn(turn: ChatTurnRequest): Promise<Response> {
    await this.ctx.storage.delete(`queued:${turn.turnId}`);
    // A prior turn that never delivered its terminal event (isolate restart
    // mid-run) would otherwise stay "running" in Convex forever.
    const stale = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (
      stale &&
      stale.turnId !== turn.turnId &&
      !(await this.ctx.storage.get<boolean>("terminalDelivered"))
    ) {
      await this.event(
        stale,
        "auto",
        "failed",
        { message: "Stella was interrupted answering this. Try again." },
        true,
      ).catch(() => undefined);
    }
    await this.ctx.storage.put({
      turn,
      terminal: false,
      terminalDelivered: false,
      alarmAttempts: 0,
    });
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
    );
    const started = performance.now();
    log("info", "chat_turn_started", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
    });
    try {
      await this.event(turn, "auto", "started", {});

      const base = turn.convexCallbackBase.replace(/\/+$/, "");
      const contextResponse = await fetch(
        `${base}/api/cloud/context?conversationId=${encodeURIComponent(
          turn.conversationId,
        )}&excludeTurnId=${encodeURIComponent(turn.turnId)}`,
        {
          headers: {
            authorization: `Bearer ${this.env.BUILDER_SERVICE_SECRET}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!contextResponse.ok) {
        throw new Error(
          `Loading the conversation failed (${contextResponse.status}).`,
        );
      }
      const contextPayload = (await contextResponse.json()) as {
        messages: Array<{ role: string; payloadJson: string }>;
      };
      const parsedHistory: AgentMessage[] = [];
      for (const row of contextPayload.messages) {
        try {
          parsedHistory.push(JSON.parse(row.payloadJson) as AgentMessage);
        } catch {
          // Skip malformed rows; degraded context beats a dead turn.
        }
      }
      // The canonical transcript only grows; keep the newest window that
      // fits the model so a long conversation can never brick on overflow.
      const history = pruneAgentHistory(parsedHistory);

      // The watchdog (or /cancel) may have fired during the setup awaits
      // above, before currentAgent exists for abort() to reach — re-check so
      // an already-terminal turn never starts the loop at all.
      if (await this.ctx.storage.get<boolean>("terminal")) {
        return json({ ok: false, canceled: true });
      }

      const agent: Agent = new Agent({
        initialState: {
          systemPrompt: CLOUD_ORCHESTRATOR_PROMPT,
          model: createCloudRelayModel({
            siteUrl: base,
            turnToken: turn.turnToken,
            agentType: "orchestrator",
            engine: turn.engine,
          }),
          thinkingLevel: "off",
          tools: this.createTools(turn),
          messages: history,
        },
        sessionId: turn.conversationId,
        getApiKey: () => turn.turnToken,
        toolExecution: "sequential",
        toolInactivityTimeoutMs: 60_000,
      });

      let eventChain: Promise<unknown> = Promise.resolve();
      const emit = (kind: string, payload: unknown) => {
        eventChain = eventChain
          .then(() => this.event(turn, "auto", kind, payload))
          .catch((error) => {
            log("error", "chat_event_failed", {
              turnId: turn.turnId,
              kind,
              message: errorMessage(error),
            });
          });
      };
      const unsubscribe = agent.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          const text = extractText(event.message);
          if (text) emit("assistant_message", { text: text.slice(0, 8_000) });
        }
        if (event.type === "tool_execution_start") {
          emit("tool_call", {
            name: event.toolName,
            args: JSON.stringify(event.args ?? {}).slice(0, 1_000),
          });
        }
      });

      this.currentAgent = agent;
      const before = agent.state.messages.length;
      try {
        await agent.prompt(turn.prompt);
      } finally {
        this.currentAgent = undefined;
      }
      unsubscribe();
      await eventChain;

      if (await this.ctx.storage.get<boolean>("terminal")) {
        // Canceled or timed out mid-loop; the terminal event is already
        // written. Persist nothing.
        return json({ ok: false, canceled: true });
      }

      // Write produced messages back to the canonical transcript. The first
      // produced row is the prompt's user message, which Convex already
      // inserted at dispatch — skip it. A failed loop persists nothing: an
      // errored assistant message has empty content, and one empty assistant
      // row poisons every future Anthropic request for the conversation.
      const loopError = agent.state.error;
      const produced = loopError
        ? []
        : agent.state.messages
            .slice(before)
            .filter(
              (message, index) =>
                !(index === 0 && (message as { role?: string }).role === "user"),
            )
            .filter((message) => {
              const record = message as { role?: string; content?: unknown };
              return !(
                record.role === "assistant" &&
                Array.isArray(record.content) &&
                record.content.length === 0
              );
            });
      if (produced.length > 0) {
        // The append route caps one request at 50 rows; persist in ordered
        // batches so a tool-heavy turn can't fail after the work succeeded.
        const rows = produced.map((message) => ({
          role: (message as { role: string }).role,
          payloadJson: JSON.stringify(message),
        }));
        // Multi-batch persist is not atomic; retry each batch once so a
        // transient failure can't strand a committed prefix while the turn
        // reports failed.
        for (const batch of chunkForAppend(rows)) {
          const post = () =>
            this.convexPost(base, "/api/cloud/messages", {
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              messages: batch,
            });
          let persist = await post();
          if (!persist.ok) persist = await post();
          if (!persist.ok) {
            throw new Error(`Persisting the reply failed (${persist.status}).`);
          }
        }
      }

      const lastAssistant = [...agent.state.messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "assistant");
      const finalText = lastAssistant ? extractText(lastAssistant) : "";
      if (loopError) {
        throw new Error(loopError);
      }
      await this.event(
        turn,
        "auto",
        "completed",
        { text: finalText, wallClockMs: Math.round(performance.now() - started) },
        true,
      );
      await this.ctx.storage.put({ terminal: true, terminalDelivered: true });
      // Keep the alarm alive while queued turns remain: it is the wake
      // guarantee that lets a restarted DO drain the durable queue.
      const queued = await this.ctx.storage.list({
        prefix: "queued:",
        limit: 1,
      });
      if (queued.size === 0) await this.ctx.storage.deleteAlarm();
      log("info", "chat_turn_completed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        wallClockMs: Math.round(performance.now() - started),
      });
      return json({ ok: true, text: finalText });
    } catch (error) {
      const message = errorMessage(error);
      log("error", "chat_turn_failed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        message,
      });
      if (!(await this.ctx.storage.get<boolean>("terminal"))) {
        await this.ctx.storage.put("terminal", true);
        try {
          // The raw message is often a provider error blob or infrastructure
          // detail; it belongs in logs, never in the user's chat bubble.
          await this.event(
            turn,
            "auto",
            "failed",
            { message: "Stella hit a problem answering this. Try again." },
            true,
          );
          await this.ctx.storage.put("terminalDelivered", true);
        } catch {
          // Delivery failed; the re-armed alarm retries so the turn cannot
          // stay "running" forever.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      return json({ error: "Cloud chat turn failed.", detail: message }, 502);
    }
  }

  private createTools(turn: ChatTurnRequest): AgentTool[] {
    const base = turn.convexCallbackBase;
    const spawn = async (body: Record<string, unknown>): Promise<string> => {
      const response = await this.convexPost(base, "/api/cloud/spawn", {
        ownerId: turn.ownerId,
        conversationId: turn.conversationId,
        parentTurnId: turn.turnId,
        ...body,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        threadId?: string;
        error?: string;
      };
      if (!response.ok || payload.ok !== true || !payload.threadId) {
        throw new Error(payload.error ?? "Spawning the agent failed.");
      }
      return payload.threadId;
    };

    return [
      {
        name: "spawn_agent",
        label: "Spawn agent",
        description:
          "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet — you'll receive an [Agent completed] message on this conversation when it reports.",
        parameters: SPAWN_AGENT_PARAMETERS as unknown as TSchema,
        execute: async (_id, params) => {
          const args = params as {
            description: string;
            prompt: string;
            workspace?: string;
            model?: string;
          };
          const workspace = args.workspace?.trim() || "drive";
          if (workspace === "computer") {
            throw new Error(
              "The user's computer isn't reachable from cloud chat yet. Run this on their machine from the desktop app, or use workspace \"drive\" for cloud work.",
            );
          }
          const model = args.model?.trim();
          if (model && model !== "default" && !/^claude(\/|$)/.test(model)) {
            throw new Error(
              'Only "claude" (the user\'s connected Claude subscription) or "claude/<model>" can be selected for cloud spawns right now. Omit model for the default.',
            );
          }
          const threadId = await spawn({
            action: "spawn",
            description: args.description,
            prompt: args.prompt,
            workspace,
            ...(model && model !== "default" ? { model } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text: `Spawned agent ${threadId} ("${args.description}") in workspace ${workspace}. It is not finished yet — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: { thread_id: threadId, workspace },
          };
        },
      },
      {
        name: "send_input",
        label: "Send input",
        description:
          "Send a follow-up message to an existing sub-agent thread after it has finished. The thread's workspace and conversation history are restored.",
        parameters: {
          type: "object",
          properties: {
            thread_id: {
              type: "string",
              description: "Durable thread id to continue or revise.",
            },
            description: {
              type: "string",
              description:
                "One short, user-friendly sentence summarizing what this work is about.",
            },
            message: {
              type: "string",
              description: "Follow-up instruction to deliver to the agent.",
            },
          },
          required: ["thread_id", "description", "message"],
        } as unknown as TSchema,
        execute: async (_id, params) => {
          const args = params as {
            thread_id: string;
            description: string;
            message: string;
          };
          const threadId = await spawn({
            action: "spawn",
            threadId: args.thread_id,
            description: args.description,
            prompt: args.message,
            workspace: "drive",
          });
          return {
            content: [
              {
                type: "text",
                text: `Delivered to ${threadId}. It is working again — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: { thread_id: threadId },
          };
        },
      },
      {
        name: "pause_agent",
        label: "Pause agent",
        description:
          "Stop a running sub-agent. The thread can be resumed later with send_input.",
        parameters: {
          type: "object",
          properties: {
            thread_id: {
              type: "string",
              description: "Durable thread id to pause.",
            },
            reason: {
              type: "string",
              description: "Optional explanation for why.",
            },
          },
          required: ["thread_id"],
        } as unknown as TSchema,
        execute: async (_id, params) => {
          const args = params as { thread_id: string };
          // Order matters: mark the thread canceled first (wake suppressed),
          // then tear down the sandbox — the BuildSession's own canceled
          // callback becomes a no-op against the already-terminal thread.
          const response = await this.convexPost(base, "/api/cloud/spawn", {
            action: "cancel",
            ownerId: turn.ownerId,
            conversationId: turn.conversationId,
            threadId: args.thread_id,
          });
          if (!response.ok) {
            throw new Error(`Thread not found: ${args.thread_id}`);
          }
          await this.env.BUILD_SESSIONS.getByName(args.thread_id)
            .fetch("https://build-session/cancel", { method: "POST" })
            .catch(() => undefined);
          return {
            content: [
              {
                type: "text",
                text: `Paused ${args.thread_id}. Resume it later with send_input.`,
              },
            ],
            details: { thread_id: args.thread_id, canceled: true },
          };
        },
      },
      {
        name: "web",
        label: "Web",
        description:
          "Search the web (query) or fetch a specific page as text (url). Provide exactly one of query or url.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Web search query." },
            url: { type: "string", description: "Exact page URL to fetch." },
          },
        } as unknown as TSchema,
        execute: async (_id, params) => {
          const args = params as { query?: string; url?: string };
          if (args.url) {
            const target = new URL(args.url);
            if (
              !/^https?:$/.test(target.protocol) ||
              /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(
                target.hostname,
              )
            ) {
              throw new Error("Only public http(s) URLs can be fetched.");
            }
            const response = await fetch(target, {
              signal: AbortSignal.timeout(15_000),
              headers: { accept: "text/html,text/plain,application/json" },
            });
            const raw = await response.text();
            const text = raw
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 20_000);
            return {
              content: [
                { type: "text", text: text || `(empty response, HTTP ${response.status})` },
              ],
              details: { status: response.status, url: args.url },
            };
          }
          if (!args.query?.trim()) {
            throw new Error("Provide a query or a url.");
          }
          const response = await this.convexPost(
            base,
            "/api/cloud/web-search",
            { query: args.query, ownerId: turn.ownerId },
          );
          if (!response.ok) {
            throw new Error(`Web search failed (${response.status}).`);
          }
          const payload = (await response.json()) as { text: string };
          return {
            content: [{ type: "text", text: payload.text || "(no results)" }],
            details: payload,
          };
        },
      },
    ];
  }
}
