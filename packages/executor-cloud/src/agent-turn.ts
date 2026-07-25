/**
 * The real cloud agent turn: Stella's own runtime (agent-core loop + tool
 * host) running headless in the sandbox as the spawned general agent.
 *
 * The BuildSession DO restores the workspace before invoking this and
 * checkpoints it after; this module only runs the loop. Model calls go
 * through the managed relay authenticated by the per-turn token; events and
 * the thread transcript stream to Convex with the same token. The final line
 * on stdout is the structured report the DO parses.
 */

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { TSchema } from "@sinclair/typebox";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";
import type { ToolContext } from "@stella/runtime/kernel/tools/host.js";
import { CLOUD_TURN_TOKEN_HEADER, createCloudRelayModel } from "./relay-model.js";
import { chunkForAppend, pruneAgentHistory } from "./prune-history.js";

export type AgentTurnInput = {
  kind: "agent";
  ownerId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  workspace: string;
  convexCallbackBase: string;
  /** Prior thread transcript rows, oldest first (send_input continuations). */
  history?: Array<{ role: string; payloadJson: string }>;
  /** Owner's engine subscription for this turn's model calls (flag only). */
  engine?: { provider: "anthropic"; model: string };
};

export type AgentTurnResult = {
  ok: boolean;
  finalText: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
};

/**
 * Pinned in code, not read from agent-metadata: the sandbox image's home-seed
 * copy is agent-writable in principle, and the cloud contract is that
 * allowlists governing execution surfaces are never data-driven.
 */
const CLOUD_GENERAL_TOOLS = [
  "exec_command",
  "write_stdin",
  "node_repl",
  "apply_patch",
  "web",
  "view_image",
] as const;

const CLOUD_GENERAL_PROMPT = (workspace: string) => `You are a Stella \
background agent running in a cloud sandbox. Complete the task you were \
given, then stop — your final message is delivered to the orchestrator as \
your report, so make it a concise, self-contained summary of what you did \
and found, including exact file paths for anything you created or changed.

Your workspace is "${workspace}" mounted at the current working directory. \
Everything you write inside it is checkpointed and persists across turns; \
anything outside it is discarded when the sandbox stops. You have bun, node, \
and git available via exec_command. You cannot spawn other agents and you \
cannot reach the user directly.`;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

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

export const runAgentTurn = (
  workspaceRoot = "/workspace/drive",
): Effect.Effect<AgentTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: async () =>
          JSON.parse(
            await readFile("/workspace/turn-input.json", "utf8"),
          ) as AgentTurnInput,
        catch: asError,
      });
      const turnToken = process.env.STELLA_TURN_TOKEN?.trim();
      if (!turnToken) {
        return yield* Effect.fail(new Error("STELLA_TURN_TOKEN is not set."));
      }
      const base = input.convexCallbackBase.replace(/\/+$/, "");
      const postJson = async (
        route: string,
        body: unknown,
      ): Promise<Response> =>
        fetch(`${base}${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CLOUD_TURN_TOKEN_HEADER]: turnToken,
          },
          body: JSON.stringify(body),
        });

      // Ordered, best-effort progress events; a lost event never fails the
      // turn (the DO writes the terminal event either way).
      let eventChain: Promise<unknown> = Promise.resolve();
      const emitEvent = (kind: string, payload: unknown): void => {
        eventChain = eventChain
          .then(() =>
            postJson("/api/cloud/events", {
              turnId: input.turnId,
              sessionId: input.threadId,
              seq: "auto",
              kind,
              payload,
            }),
          )
          .catch((error) => {
            console.error(`event ${kind} failed: ${asError(error).message}`);
          });
      };

      yield* Effect.tryPromise({
        try: () => mkdir(path.join(workspaceRoot, ".stella"), { recursive: true }),
        catch: asError,
      });
      const toolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: path.join(workspaceRoot, ".stella"),
            webSearch: async (query, options) => {
              const response = await postJson("/api/cloud/web-search", {
                query,
                category: options?.category,
              });
              if (!response.ok) {
                return { text: `WebSearch failed (${response.status}).` };
              }
              return (await response.json()) as {
                text: string;
                results?: Array<{ title: string; url: string; snippet: string }>;
              };
            },
          }),
        ),
        (host) =>
          Effect.tryPromise({ try: () => host.shutdown(), catch: asError }).pipe(
            Effect.orDie,
          ),
      );

      const context: ToolContext = {
        conversationId: input.threadId,
        deviceId: "cloud",
        requestId: crypto.randomUUID(),
        agentType: "general",
        workingDirectory: workspaceRoot,
        stellaAppDir: workspaceRoot,
        stellaDataDir: path.join(workspaceRoot, ".stella"),
        toolWorkspaceRoot: workspaceRoot,
        storageMode: "cloud",
        agentId: input.threadId,
        agentDepth: 1,
        maxAgentDepth: 1,
      };

      const catalog = toolHost.getToolCatalog("general", {});
      const byName = new Map(catalog.map((tool) => [tool.name, tool]));
      const tools: AgentTool[] = [];
      for (const name of CLOUD_GENERAL_TOOLS) {
        const meta = byName.get(name);
        if (!meta) continue;
        tools.push({
          name,
          label: meta.label ?? name,
          ...(meta.workingText ? { workingText: meta.workingText } : {}),
          description: meta.description,
          parameters: meta.parameters as unknown as TSchema,
          execute: async (_toolCallId, params, signal) => {
            const result = await toolHost.executeTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              context,
              signal,
            );
            if (result.error) throw new Error(result.error);
            const text =
              typeof result.result === "string"
                ? result.result
                : result.result === undefined
                  ? ""
                  : JSON.stringify(result.result, null, 2);
            return {
              content: [
                {
                  type: "text",
                  text: text.length > 30_000
                    ? `${text.slice(0, 15_000)}\n…[truncated]…\n${text.slice(-15_000)}`
                    : text || "(no output)",
                },
              ],
              details: result.details ?? null,
            };
          },
        });
      }

      const parsedHistory: AgentMessage[] = [];
      for (const row of input.history ?? []) {
        try {
          parsedHistory.push(JSON.parse(row.payloadJson) as AgentMessage);
        } catch {
          // A malformed historical row degrades context, never the turn.
        }
      }
      // Long-running threads accumulate transcript across send_input
      // continuations; keep the newest window that fits the model.
      const history = pruneAgentHistory(parsedHistory);

      const agent = new Agent({
        initialState: {
          systemPrompt: CLOUD_GENERAL_PROMPT(input.workspace),
          model: createCloudRelayModel({
            siteUrl: base,
            turnToken,
            agentType: "general",
            engine: input.engine,
          }),
          thinkingLevel: "off",
          tools,
          messages: history,
        },
        sessionId: input.threadId,
        getApiKey: () => turnToken,
        toolExecution: "sequential",
        toolInactivityTimeoutMs: 5 * 60_000,
      });

      let llmCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          llmCalls += 1;
          const usage = (event.message as { usage?: { input?: number; output?: number; inputTokens?: number; outputTokens?: number } }).usage;
          inputTokens += usage?.inputTokens ?? usage?.input ?? 0;
          outputTokens += usage?.outputTokens ?? usage?.output ?? 0;
          const text = extractText(event.message);
          if (text) emitEvent("assistant_message", { text: text.slice(0, 8_000) });
        }
        if (event.type === "tool_execution_start") {
          emitEvent("tool_call", {
            name: event.toolName,
            args: JSON.stringify(event.args ?? {}).slice(0, 1_000),
          });
        }
      });

      const before = agent.state.messages.length;
      yield* Effect.tryPromise({
        try: () => agent.prompt(input.prompt),
        catch: asError,
      });
      unsubscribe();
      yield* Effect.promise(() => eventChain.then(() => undefined));

      // Persist the thread transcript (conversationId = threadId) so
      // send_input continuations restore full conversational context, not
      // just the workspace.
      // Errored assistant messages have empty content; one empty assistant
      // row poisons every future Anthropic request for this thread.
      const produced = agent.state.messages.slice(before).filter((message) => {
        const record = message as { role?: string; content?: unknown };
        return !(
          record.role === "assistant" &&
          Array.isArray(record.content) &&
          record.content.length === 0
        );
      });
      if (produced.length > 0) {
        // The append route caps one request at 50 rows; a busy turn (each
        // tool call is an assistant + toolResult pair) easily exceeds that,
        // so persist in ordered batches.
        yield* Effect.tryPromise({
          try: async () => {
            const rows = produced.map((message) => ({
              role: (message as { role: string }).role,
              payloadJson: JSON.stringify(message),
            }));
            // Multi-batch persist is not atomic; retry each batch once so a
            // transient failure can't strand a committed prefix while the
            // turn reports failed.
            for (const batch of chunkForAppend(rows)) {
              let response = await postJson("/api/cloud/messages", {
                conversationId: input.threadId,
                turnId: input.turnId,
                messages: batch,
              });
              if (!response.ok) {
                response = await postJson("/api/cloud/messages", {
                  conversationId: input.threadId,
                  turnId: input.turnId,
                  messages: batch,
                });
              }
              if (!response.ok) {
                throw new Error(
                  `Thread transcript persist failed (${response.status}).`,
                );
              }
            }
          },
          catch: asError,
        });
      }

      const lastAssistant = [...agent.state.messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "assistant");
      const finalText = lastAssistant ? extractText(lastAssistant) : "";
      const error = agent.state.error;
      return {
        ok: !error,
        finalText:
          finalText || (error ? "" : "The agent finished without a report."),
        ...(error ? { error } : {}),
        usage: { inputTokens, outputTokens, llmCalls },
      } satisfies AgentTurnResult;
    }),
  );
