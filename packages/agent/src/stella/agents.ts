/**
 * Stella's orchestrator → agent → agent hierarchy on pi-durable.
 *
 * Each agent is a conversation owned by a background **anchor** task in the
 * conversation that started it, so the starter's Stop and idle never wait on
 * it (pi-durable's example 23). Every message to an agent, the first prompt
 * included, is carried by a background **reporter** task in the starter: it
 * submits the message to the agent, waits for the agent's answer, and reports
 * it one level up. When the starter is the orchestrator, the report becomes
 * the orchestrator's next input (`[Agent completed] ...`); when the starter is
 * itself an agent, the report is a new message to that agent, carried by a
 * reporter in *its* starter, so a nested result climbs the chain one hop at a
 * time. Request ids derived from task ids make every hop exactly-once across
 * restarts.
 *
 * The tools are Stella's own descriptors: `spawn_agent`, `send_message`,
 * `agent_status`, `pause_agent`.
 */
import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type ModelRef,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { parseStellaModelId, stellaModelId, STELLA_PROVIDER_ID } from "../provider/stella.ts";
import { MAX_AGENT_DEPTH, StellaAgentDoc, type StellaAgentRole } from "./agent-doc.ts";
import { agentToolSelection } from "./host-tools.ts";
import {
  describePlacement,
  parseSpawnDestination,
  placementOf,
  StellaPlacementDoc,
  type SpawnDestination,
  type StellaPlacement,
} from "./placement.ts";

export const STELLA_AGENTS_EXTENSION = "stella-agents";

type AgentRecord = {
  conversationId: number;
  description: string;
  placement: { kind: "local" | "cloud" | "device"; deviceId?: string };
  /** Answers already reported, so two messages answered by one run report once. */
  reported: number[];
};

/** The agents a conversation started, by thread id. */
export const StellaAgentsDoc = defineDoc<{
  agents: Record<string, AgentRecord>;
  /** Tool task id → what that call did, so a rerun of the call does it once. */
  calls: Record<string, { threadId: string; reporter: number }>;
}>({
  kind: "stella.agents",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork does not inherit the agents of the conversation it forked from.
  fork: "initial",
  initial: () => ({ agents: {}, calls: {} }),
});

/** A message on its way to an agent. */
export type AgentRun = {
  threadId: string;
  agentConversationId: ConversationId;
  /** The conversation that started the agent; the reporter lives there. */
  parentConversationId: ConversationId;
  /** Unique per message: `agent-run:<reporter task id>`. */
  runId: string;
};

/** An agent's report, arriving at the orchestrator. */
export type AgentReport = {
  rootConversationId: ConversationId;
  threadId: string;
  text: string;
  /** Exactly-once key for the delivery. */
  requestId: string;
};

export type StellaAgentsHost = {
  /** Where an agent runs, given what the caller asked for and where the caller runs. */
  place(destination: SpawnDestination, caller: StellaPlacement): StellaPlacement | { error: string };
  /** Where the orchestrator itself runs. */
  rootPlacement: StellaPlacement;
  /**
   * Before a message goes to an agent, and after the agent's run settles:
   * the cloud admits the run and binds its model capability here.
   */
  beginAgentRun?(run: AgentRun, context: Context): Promise<void>;
  endAgentRun?(run: AgentRun, context: Context): Promise<void>;
  /**
   * A report for the orchestrator. Default: a follow-up input to the root
   * conversation. The cloud sends it through its turn plane instead.
   */
  deliverReport?(report: AgentReport, context: Context): Promise<void>;
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

const textOf = (message: AssistantMessage | undefined): string =>
  (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("").trim();

const MAX_REPORT_CHARS = 30_000;
const bounded = (text: string): string =>
  text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS)}\n[truncated ${text.length - MAX_REPORT_CHARS} chars]`;

export const completedReport = (args: { threadId: string; description: string; result: string; toParentAgent: boolean }): string =>
  [
    "[Agent completed]",
    `description: ${args.description}`,
    `thread_id: ${args.threadId}`,
    "agent_type: general",
    `result: ${bounded(args.result || "(no reply)")}`,
    "agent_state: paused; use send_message on the same thread if follow-up work is needed.",
    ...(args.toParentAgent
      ? ["routing: your subagent's report has returned. It reaches only you, not the user; continue your own task with it."]
      : []),
  ].join("\n");

export const failedReport = (args: { threadId: string; description: string; error: string }): string =>
  ["[Task failed]", `thread_id: ${args.threadId}`, "agent_type: general", `description: ${args.description}`, `error: ${bounded(args.error)}`].join("\n");

const roleOf = async (
  reader: Pick<TaskRuntime<unknown, { phase: string }, unknown, object>, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<StellaAgentRole> => (await reader.snapshot(StellaAgentDoc, conversationId, context)) ?? { agentType: "orchestrator", depth: 0 };

/** Owns one agent conversation. Completes at once; background, so its owner's Stop and idle stop here. */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "stella.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
  },
  abort: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ReporterInput = { threadId: string; conversationId: number; message: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

export function stellaAgentsExtension(host: StellaAgentsHost) {
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "stella.agent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { threadId, message } = reporter.input;
        const agentConversationId = reporter.input.conversationId as ConversationId;
        const run: AgentRun = {
          threadId,
          agentConversationId,
          parentConversationId: runtime.conversationId,
          runId: `agent-run:${reporter.id}`,
        };
        let settled: Awaited<ReturnType<Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof runtime.conversation>>>["submit"]>>["wait"]>> | undefined;
        // A run the host refuses (admission, credentials) is reported as failed.
        let refused: string | undefined;
        try {
          await host.beginAgentRun?.(run, context);
          const agent = await runtime.conversation(agentConversationId, context);
          if (!agent) throw new Error(`Agent ${threadId} no longer exists.`);
          const submission = await agent.submit(
            { type: "input", content: message, whenBusy: "steer", requestId: `agent-msg:${reporter.id}` },
            context,
          );
          settled = await submission.wait(context);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          refused = error instanceof Error ? error.message : String(error);
        } finally {
          await host.endAgentRun?.(run, context);
        }
        // Read before the commit: nothing may wait on the Session inside it.
        const self = await roleOf(runtime, runtime.conversationId, context);
        await runtime.commit(async (tx) => {
          const next = (report?: string): { status: "running"; checkpoint: ReporterState } => ({
            status: "running",
            checkpoint: report === undefined ? { phase: "report" } : { phase: "report", report },
          });
          const state = await tx.doc(StellaAgentsDoc, runtime.conversationId);
          const agent = state.agents[threadId];
          const description = agent?.description ?? threadId;
          if (refused !== undefined || settled === undefined) {
            return next(failedReport({ threadId, description, error: refused ?? "The agent did not run." }));
          }
          if (settled.status === "unanswered") {
            // Paused: nothing to report.
            if (settled.reason === "aborted") return next();
            return next(failedReport({ threadId, description, error: settled.reason }));
          }
          if (settled.type !== "input" || !agent) return next();
          if (agent.reported.includes(settled.answer)) return next();
          agent.reported.push(settled.answer);
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
          return next(
            completedReport({ threadId, description, result: textOf(answer), toParentAgent: self.agentType !== "orchestrator" }),
          );
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const report = reporter.state.checkpoint.report;
        const self = await roleOf(runtime, runtime.conversationId, context);
        if (report !== undefined && (self.agentType === "orchestrator" || self.parentConversationId === undefined)) {
          const delivery: AgentReport = {
            rootConversationId: runtime.conversationId,
            threadId: reporter.input.threadId,
            text: report,
            requestId: `agent-report:${reporter.id}`,
          };
          if (host.deliverReport) {
            await host.deliverReport(delivery, context);
          } else {
            const root = await runtime.conversation(runtime.conversationId, context);
            await root?.submit({ type: "input", content: report, whenBusy: "followUp", requestId: delivery.requestId }, context);
          }
        }
        await runtime.commit(async (tx) => {
          // A report to an agent is the next message to that agent, carried
          // by a reporter in the conversation that started it.
          if (report !== undefined && self.agentType !== "orchestrator" && self.parentConversationId !== undefined && self.threadId) {
            await tx.createTask(
              Reporter,
              { threadId: self.threadId, conversationId: runtime.conversationId, message: report },
              {
                ownership: { kind: "conversation" },
                background: true,
                conversationId: self.parentConversationId as ConversationId,
              },
            );
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (_reporter, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  const childModel = (parent: ModelRef | undefined): ModelRef | undefined => {
    if (parent?.provider !== STELLA_PROVIDER_ID) return parent;
    const parsed = parseStellaModelId(parent.modelId);
    return parsed ? { provider: STELLA_PROVIDER_ID, modelId: stellaModelId("general", parsed.alias) } : parent;
  };

  const callerPlacement = async (api: ToolExecutionApi, context: Context): Promise<StellaPlacement> =>
    placementOf(await api.snapshot(StellaPlacementDoc, api.conversationId, context)) ?? host.rootPlacement;

  const spawnAgent = defineTool({
    name: "spawn_agent",
    description:
      "Start a background agent for work that needs its own owner. Continue related work with an existing agent through send_message, even when it is busy. Agents can delegate independent parts to subagents. The immediate result means work has started; completion arrives in [Agent completed].",
    parameters: Type.Object({
      description: Type.String({
        description: "A short name for the project or area of work. It becomes the thread's name; put distinguishing words first.",
      }),
      prompt: Type.String({
        description:
          "The request and any necessary context the agent does not have. Keep simple requests short; preserve explicit constraints and leave the approach to the agent.",
      }),
      model: Type.Optional(
        Type.String({ description: "Optional model override, such as `stella/default`. Omit to use the configured model." }),
      ),
      destination: Type.Optional(
        Type.String({ description: 'Where the agent runs: "cloud", or a device_id from the connected devices list. Omit to run it where you are.' }),
      ),
    }),
    // A rerun finds this call's spawn in `calls` and does nothing again.
    replay: "safe",
    execute: async (args, api, context) => {
      const caller = await roleOf(api, api.conversationId, context);
      const depth = caller.depth + 1;
      if (depth > MAX_AGENT_DEPTH) throw new Error("This agent is at the nesting limit and cannot start agents of its own.");
      const placement = host.place(parseSpawnDestination(args.destination), await callerPlacement(api, context));
      if ("error" in placement) throw new Error(placement.error);
      const callerAgent = await api.agent(context);
      const requested = args.model?.trim();
      const model =
        requested && requested.startsWith("stella/")
          ? { provider: STELLA_PROVIDER_ID, modelId: stellaModelId("general", requested) }
          : childModel(callerAgent.model);
      const description = args.description.trim() || "agent";
      const { threadId, existing } = await api.commit(async (tx) => {
        const state = await tx.doc(StellaAgentsDoc, api.conversationId);
        const prior = state.calls[String(api.taskId)];
        if (prior) return { threadId: prior.threadId, existing: true };
        const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        const threadId = `${slug(description)}-${child.id}`;
        await configure(tx, child.id, {
          ...(model ? { model } : {}),
          // An agent has file, shell and agent tools, not the orchestrator's
          // (it copied the starter's selection); one at the depth limit cannot
          // start agents.
          extensions: agentToolSelection,
          tools: depth >= MAX_AGENT_DEPTH ? { remove: [spawnAgent, pauseAgent] } : null,
        });
        const role = await tx.doc(StellaAgentDoc, child.id);
        role.agentType = "general";
        role.depth = depth;
        role.description = description;
        role.threadId = threadId;
        role.parentConversationId = api.conversationId;
        const where = await tx.doc(StellaPlacementDoc, child.id);
        where.kind = placement.kind;
        if (placement.kind === "device") where.deviceId = placement.deviceId;
        state.agents[threadId] = {
          conversationId: child.id,
          description,
          placement: { kind: placement.kind, ...(placement.kind === "device" ? { deviceId: placement.deviceId } : {}) },
          reported: [],
        };
        const reporter = await tx.createTask(
          Reporter,
          { threadId, conversationId: child.id, message: args.prompt },
          { ownership: { kind: "conversation" }, background: true },
        );
        state.calls[String(api.taskId)] = { threadId, reporter };
        return { threadId, existing: false };
      }, context);
      await api.details({ thread_id: threadId }, context);
      return {
        content: [
          {
            type: "text",
            text: `${existing ? "Already started" : "Started"} ${threadId} (${describePlacement(placement)}). thread_id: ${threadId}. Its report arrives in [Agent completed].`,
          },
        ],
        details: { thread_id: threadId },
      };
    },
  });

  const sendMessage = defineTool({
    name: "send_message",
    description:
      "Message an agent you started by thread_id, including while it is busy; it reads the message before its next step. Steer it, correct it, or resume it on the same thread after it finished or was paused. A successful result means the message was delivered, not that any work finished; completion still arrives in [Agent completed]. agent_status without a thread_id lists who you can reach.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "A thread_id from agent_status." }),
      message: Type.String({ description: "The message. To your own agent, send only what is new or changed." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const threadId = args.thread_id.trim();
      await api.commit(async (tx) => {
        const state = await tx.doc(StellaAgentsDoc, api.conversationId);
        if (state.calls[String(api.taskId)]) return;
        const agent = state.agents[threadId];
        if (!agent) throw new Error(`No agent ${threadId} here. agent_status lists the ones you started.`);
        const reporter = await tx.createTask(
          Reporter,
          { threadId, conversationId: agent.conversationId, message: args.message },
          { ownership: { kind: "conversation" }, background: true },
        );
        state.calls[String(api.taskId)] = { threadId, reporter };
      }, context);
      return { content: [{ type: "text", text: `Delivered to ${threadId}.` }] };
    },
  });

  const status = async (api: ToolExecutionApi, threadId: string, agent: AgentRecord, context: Context, detailed: boolean) => {
    const conversationId = agent.conversationId as ConversationId;
    const live = await api.snapshot(LiveDoc, conversationId, context);
    const lines = [
      `- ${threadId}: ${agent.description} [${describePlacement(placementOf(agent.placement) ?? host.rootPlacement)}] ${live?.run !== undefined ? "running" : "idle"}`,
    ];
    if (detailed) {
      const running = live?.tools?.filter((tool) => tool.status === "running").map((tool) => tool.name) ?? [];
      if (running.length) lines.push(`  running tools: ${running.join(", ")}`);
      const recent = await api.commit(
        async (tx) => (await tx.scanEntries({ conversationId, order: "descending" }, 20)).items,
        context,
      );
      const lastAnswer = recent.find((entry) => entry.kind === "pi.assistant");
      const message = lastAnswer?.model?.[0] as AssistantMessage | undefined;
      const text = textOf(message);
      if (text) lines.push(`  latest message: ${text.slice(0, 2_000)}`);
      const call = message?.content.find((part) => part.type === "toolCall");
      if (call && call.type === "toolCall") lines.push(`  latest tool call: ${call.name}`);
    }
    return lines.join("\n");
  };

  const agentStatus = defineTool({
    name: "agent_status",
    description:
      "Without thread_id: list the agents you started, with each one's thread_id, what it is working on, where it runs, and its status. With thread_id: that agent's status, latest message and tool call. Read-only.",
    parameters: Type.Object({
      thread_id: Type.Optional(Type.String({ description: "The agent to inspect. Omit it to list everyone you can reach." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const state = (await api.snapshot(StellaAgentsDoc, api.conversationId, context)) ?? { agents: {}, calls: {} };
      const threadId = args.thread_id?.trim();
      if (threadId) {
        const agent = state.agents[threadId];
        if (!agent) throw new Error(`No agent ${threadId} here.`);
        return { content: [{ type: "text", text: await status(api, threadId, agent, context, true) }] };
      }
      const entries = Object.entries(state.agents);
      if (entries.length === 0) return { content: [{ type: "text", text: "No agents yet." }] };
      const lines = await Promise.all(entries.map(([id, agent]) => status(api, id, agent, context, false)));
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  const pauseAgent = defineTool({
    name: "pause_agent",
    description: "Pause a running agent by thread_id. Resume the same thread later with send_message.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Durable thread id of the agent to pause." }),
      reason: Type.Optional(Type.String({ description: "Optional explanation for why the agent is being paused." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const threadId = args.thread_id.trim();
      const state = await api.snapshot(StellaAgentsDoc, api.conversationId, context);
      const agent = state?.agents[threadId];
      if (!agent) throw new Error(`No agent ${threadId} here.`);
      const handle = await api.conversation(agent.conversationId as ConversationId, context);
      await handle?.abort(context);
      return { content: [{ type: "text", text: `Paused ${threadId}.` }] };
    },
  });

  return defineExtension({
    name: STELLA_AGENTS_EXTENSION,
    tasks: [Anchor, Reporter],
    tools: [spawnAgent, sendMessage, agentStatus, pauseAgent],
  });
}

export type { TaskId, EntryId };
