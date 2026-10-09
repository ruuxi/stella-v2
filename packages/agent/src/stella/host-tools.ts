/**
 * Stella's own tools on pi-durable (web, html, image_gen, ask_user and the
 * rest), executed by the host that opened the harness: the desktop runtime's
 * tool host, or the cloud orchestrator's turn tools. The harness knows them
 * by their specs only, the same descriptors every other path uses, whose JSON
 * Schema parameters TypeBox 1.x validates as they are.
 *
 * Each agent type has its own extension, so a conversation selects its set by
 * name: the orchestrator's, or an agent's. An agent's file and shell tools
 * are pi-durable's own (`stella-coding`), through its ExecutionEnv, wherever
 * it runs.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { StellaAgentDoc } from "./agent-doc.ts";

export const STELLA_ORCHESTRATOR_TOOLS = "stella-tools-orchestrator";
export const STELLA_AGENT_TOOLS = "stella-tools-agent";

export type StellaToolRole = "orchestrator" | "general";

/**
 * Tools the harness has itself, under these names or older ones: the agent
 * tools and an agent's file and shell tools. A host's catalog offers the
 * rest, `code` included.
 */
export const STELLA_HARNESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_message",
  "pause_agent",
  "agent_status",
  "Bash",
  "exec_command",
  "write_stdin",
  "apply_patch",
  "Write",
  "Edit",
  "Grep",
  "multi_tool_use_parallel",
  "NoResponse",
  "node_repl",
  // The harness has its own, which moves where a conversation's tools run.
  "switch_destination",
]);

export type StellaToolSpec = {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /**
   * Whether a call interrupted by a restart may run again: `keyed` tools do
   * their work once per call id, so a rerun is as safe as a `safe` one.
   */
  replay?: "safe" | "keyed" | "unsafe";
  /** A demoted tool: reached only through `code` when the agent has it, directly otherwise. */
  codeOnly?: { searchTerms?: readonly string[] };
};

export type StellaToolCall = {
  role: StellaToolRole;
  name: string;
  /** The model's tool call id, the same on every run of the call. */
  callId: string;
  args: Record<string, unknown>;
  /** The calling agent's thread id; the orchestrator has none. */
  threadId?: string;
};

export type StellaToolOutcome = {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
};

export interface StellaToolHost {
  /** The tools an agent type is offered, as the host has them now. */
  specs(role: StellaToolRole): readonly StellaToolSpec[];
  run(call: StellaToolCall, context: Context): Promise<StellaToolOutcome>;
}

const jsonDetails = (details: unknown): JsonValue | undefined => {
  if (details === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(details)) as JsonValue;
  } catch {
    return undefined;
  }
};

const register = (role: StellaToolRole, spec: StellaToolSpec, host: StellaToolHost): ToolRegistration => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters as unknown as TSchema,
  replay: spec.replay === "safe" || spec.replay === "keyed" ? "safe" : "unsafe",
  async execute(args, api, context) {
    const agent = role === "general" ? await api.snapshot(StellaAgentDoc, api.conversationId, context) : undefined;
    // pi-durable cancels a call's context when the call ends. Work a tool
    // leaves running (a code cell that yielded) must outlive the call, so the
    // host's signal follows the context only while the call is in flight.
    const controller = new AbortController();
    const parent = context.abortSignal;
    const forward = () => controller.abort(parent?.reason);
    if (parent?.aborted) forward();
    else parent?.addEventListener("abort", forward, { once: true });
    let outcome: StellaToolOutcome;
    try {
      outcome = await host.run(
        {
          role,
          name: spec.name,
          callId: api.callId,
          args: (args ?? {}) as Record<string, unknown>,
          ...(agent?.threadId ? { threadId: agent.threadId } : {}),
        },
        withAbortSignal(controller.signal, withoutAbortSignal(context)),
      );
    } finally {
      parent?.removeEventListener("abort", forward);
    }
    const details = jsonDetails(outcome.details);
    return {
      content: outcome.content.length > 0 ? outcome.content : [{ type: "text", text: "(no output)" }],
      ...(outcome.isError ? { isError: true } : {}),
      ...(details === undefined ? {} : { details }),
    };
  },
});

/** Stella's Code Mode tool: nested calls reach the host's tools through it (`tools.<name>`). */
export const STELLA_CODE_TOOL_NAME = "code";

/** The orchestrator's and the agents' tool extensions, from the host's current specs. */
export function stellaToolExtensions(host: StellaToolHost | undefined): Extension[] {
  const build = (role: StellaToolRole, name: string) => {
    const specs = host?.specs(role) ?? [];
    const code = specs.some((spec) => spec.name === STELLA_CODE_TOOL_NAME);
    return defineExtension({
      name,
      tools: host ? specs.filter((spec) => !(code && spec.codeOnly)).map((spec) => register(role, spec, host)) : [],
    });
  };
  return [build("orchestrator", STELLA_ORCHESTRATOR_TOOLS), build("general", STELLA_AGENT_TOOLS)];
}

/** An agent conversation's selection: everything but the orchestrator's tools. */
export const agentToolSelection = { remove: [{ name: STELLA_ORCHESTRATOR_TOOLS }] } as const;
