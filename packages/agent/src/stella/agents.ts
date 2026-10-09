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
import { Type, type AssistantMessage, type ModelThinkingLevel } from "@earendil-works/pi-ai";
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
  type Harness,
  type Tx,
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
  /** Its conversation here; -1 for an agent that runs somewhere else. */
  conversationId: number;
  description: string;
  placement: { kind: "local" | "cloud" | "device"; deviceId?: string };
  /** Answers already reported, so two messages answered by one run report once. */
  reported: number[];
  /** It runs on another host as a whole (`StellaAgentsHost.remote`). */
  remote?: true;
  /** When a remote agent was started; a local one dates from its first entry. */
  startedAt?: number;
  /**
   * The reports that came back from a remote agent, by request id: one per
   * message it was given (`noteRemoteReport`), so it runs while it has fewer.
   */
  answered?: string[];
  /** Its latest report was a failure. */
  failed?: true;
  /** It was started here for another host's orchestrator, which gets its reports. */
  origin?: { deviceId: string };
};

/** One of the orchestrator's agents as the app lists it. */
export type StellaAgentRecord = {
  threadId: string;
  description: string;
  placement: AgentRecord["placement"];
  status: "running" | "completed" | "error";
  startedAt: number;
  updatedAt: number;
  /** Its latest prose, oldest first. */
  assistantMessages: string[];
  error?: string;
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
/** The model an agent runs on, and at what thinking level. */
type RunsOn = { model?: ModelRef; thinkingLevel?: ModelThinkingLevel };

export type AgentReport = {
  rootConversationId: ConversationId;
  threadId: string;
  text: string;
  /** Exactly-once key for the delivery. */
  requestId: string;
  /** The agent was started here for another host's orchestrator: the report is for it. */
  origin?: { deviceId: string };
  /**
   * For an agent started for another host: one of its messages was answered
   * within another report, or its run was paused. No text; that host counts
   * one report per message it sent.
   */
  settled?: true;
};

/**
 * A report of a remote agent came back to the conversation that started it
 * (`StellaAgentsHost.remote`), or one of its messages was settled without
 * one. Once per `requestId`. False when the conversation never started that
 * agent: the report is not for it.
 */
export const noteRemoteReport = async (
  tx: Pick<Tx, "doc">,
  conversationId: ConversationId,
  report: { threadId: string; requestId: string; text?: string },
): Promise<boolean> => {
  const agent = (await tx.doc(StellaAgentsDoc, conversationId)).agents[report.threadId];
  if (!agent?.remote) return false;
  if (agent.answered?.includes(report.requestId)) return true;
  agent.answered = [...(agent.answered ?? []), report.requestId];
  if (report.text === undefined) return true;
  if (report.text.trimStart().startsWith("[Task failed]")) agent.failed = true;
  else delete agent.failed;
  return true;
};

/** An agent another host placed here, and one run of it (`runPlacedAgent`). */
export type PlacedAgentRun = {
  /** The agent's identity at the host that placed it, the same for each of its runs. */
  agentKey: string;
  /** This run (a continued agent runs again under the same `agentKey`). */
  runKey: string;
  description: string;
  prompt: string;
  /** The host that placed it canceled it: it stops, or never starts. */
  signal?: AbortSignal;
};

export type PlacedAgentResult = { threadId: string } & ({ status: "ok"; finalText: string } | { status: "error"; error: string });

/**
 * An agent that runs on another host as a whole, so it keeps working while
 * this one sleeps: the host starts it there and carries messages to it, and
 * its report reaches the orchestrator the way that host's reports do (a
 * wake turn in the cloud, the conversation's journal on a computer).
 */
export type RemoteAgentHost = {
  /** Start it there. Its thread id there names it everywhere. Once per `key`. */
  start(args: { key: string; description: string; prompt: string }, context: Context): Promise<{ threadId: string }>;
  /** Another message for it: steers it there, or starts its next run. Once per `key`. */
  message(args: { key: string; threadId: string; message: string }, context: Context): Promise<void>;
  /** Its status there, as one line. */
  status?(threadId: string, context: Context): Promise<string>;
  pause?(threadId: string, context: Context): Promise<void>;
};

export type StellaAgentsHost = {
  /** Where an agent runs, given what the caller asked for and where the caller runs. */
  place(destination: SpawnDestination, caller: StellaPlacement): StellaPlacement | { error: string };
  /** The host that runs agents placed there, when they run somewhere else as a whole. */
  remote?(placement: StellaPlacement): RemoteAgentHost | undefined;
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
  /** An agent's report reached the orchestrator: the desktop tells the user. */
  agentReported?(agent: { threadId: string; description: string; failed: boolean; report: string }): void;
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

const textOf = (message: AssistantMessage | undefined): string =>
  (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("").trim();

/** Any message's text: a user message's content may be a plain string. */
const messageText = (message: { content?: unknown } | undefined): string =>
  typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? (message.content as Array<{ type?: string; text?: string }>).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")
      : "";

const MAX_REPORT_CHARS = 30_000;
const bounded = (text: string): string =>
  text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS)}\n[truncated ${text.length - MAX_REPORT_CHARS} chars]`;

export const completedReport = (args: {
  threadId: string;
  description: string;
  result: string;
  toParentAgent: boolean;
  /** What the user wrote to the agent in its thread, when this answers it. */
  userMessage?: string;
}): string =>
  [
    "[Agent completed]",
    `description: ${args.description}`,
    `thread_id: ${args.threadId}`,
    "agent_type: general",
    ...(args.userMessage === undefined
      ? []
      : [`user_message: the user wrote to this agent in its thread: ${JSON.stringify(bounded(args.userMessage))}`]),
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

type ReporterInput = {
  threadId: string;
  conversationId: number;
  message: string;
  /** The user wrote the message in the agent's thread, not the parent. */
  fromUser?: true;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

export function stellaAgents(host: StellaAgentsHost) {
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
            completedReport({
              threadId,
              description,
              result: textOf(answer),
              toParentAgent: self.agentType !== "orchestrator",
              ...(reporter.input.fromUser ? { userMessage: message } : {}),
            }),
          );
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const report = reporter.state.checkpoint.report;
        const self = await roleOf(runtime, runtime.conversationId, context);
        const origin =
          self.agentType === "orchestrator" || self.parentConversationId === undefined
            ? (await runtime.snapshot(StellaAgentsDoc, runtime.conversationId, context))?.agents[reporter.input.threadId]?.origin
            : undefined;
        if (report === undefined && origin && host.deliverReport) {
          await host.deliverReport(
            {
              rootConversationId: runtime.conversationId,
              threadId: reporter.input.threadId,
              text: "",
              requestId: `agent-report:${reporter.id}`,
              origin,
              settled: true,
            },
            context,
          );
        }
        if (report !== undefined && (self.agentType === "orchestrator" || self.parentConversationId === undefined)) {
          const delivery: AgentReport = {
            rootConversationId: runtime.conversationId,
            threadId: reporter.input.threadId,
            text: report,
            requestId: `agent-report:${reporter.id}`,
            ...(origin ? { origin } : {}),
          };
          if (host.deliverReport) {
            await host.deliverReport(delivery, context);
          } else {
            const root = await runtime.conversation(runtime.conversationId, context);
            await root?.submit({ type: "input", content: report, whenBusy: "followUp", requestId: delivery.requestId }, context);
          }
          if (host.agentReported && !origin) {
            const agent = (await runtime.snapshot(StellaAgentsDoc, runtime.conversationId, context))?.agents[reporter.input.threadId];
            host.agentReported({
              threadId: reporter.input.threadId,
              description: agent?.description ?? reporter.input.threadId,
              failed: report.trimStart().startsWith("[Task failed]"),
              report,
            });
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

  /**
   * What an agent runs on, from its caller: Stella's alias as a general
   * agent, or else the caller's own model at the caller's thinking level (a
   * ChatGPT plan turn is admitted for one reasoning effort).
   */
  const childRun = (caller: RunsOn): RunsOn => {
    const parent = caller.model;
    if (parent?.provider !== STELLA_PROVIDER_ID) {
      return { model: parent, ...(caller.thinkingLevel ? { thinkingLevel: caller.thinkingLevel } : {}) };
    }
    const parsed = parseStellaModelId(parent.modelId);
    return { model: parsed ? { provider: STELLA_PROVIDER_ID, modelId: stellaModelId("general", parsed.alias) } : parent };
  };

  const callerPlacement = async (api: ToolExecutionApi, context: Context): Promise<StellaPlacement> =>
    placementOf(await api.snapshot(StellaPlacementDoc, api.conversationId, context)) ?? host.rootPlacement;

  /**
   * Create an agent under `parentConversationId` and its first reporter,
   * once per `callKey`: an agent conversation owned by a background anchor,
   * its role, placement and tools, and its entry in the parent's agents.
   */
  const createAgent = async (
    tx: Tx,
    args: {
      parentConversationId: ConversationId;
      callKey: string;
      depth: number;
      description: string;
      prompt: string;
      runsOn: RunsOn;
      placement: StellaPlacement;
      /** Its caller runs it and reads its answer itself; nothing reports here. */
      detached?: boolean;
      /** The thread id another host chose for it, instead of one made here. */
      threadId?: string;
      /** Started here for another host's orchestrator. */
      origin?: { deviceId: string };
    },
  ): Promise<{ threadId: string; existing: boolean }> => {
    const { parentConversationId, depth, description, runsOn, placement } = args;
    const state = await tx.doc(StellaAgentsDoc, parentConversationId);
    const prior = state.calls[args.callKey];
    if (prior) return { threadId: prior.threadId, existing: true };
    const anchor = await tx.createTask(Anchor, null, {
      ownership: { kind: "conversation" },
      background: true,
      conversationId: parentConversationId,
    });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    const threadId = args.threadId && !state.agents[args.threadId] ? args.threadId : `${slug(description)}-${child.id}`;
    await configure(tx, child.id, {
      ...(runsOn.model ? { model: runsOn.model } : {}),
      ...(runsOn.thinkingLevel ? { thinkingLevel: runsOn.thinkingLevel } : {}),
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
    role.parentConversationId = parentConversationId;
    const where = await tx.doc(StellaPlacementDoc, child.id);
    where.kind = placement.kind;
    if (placement.kind === "device") where.deviceId = placement.deviceId;
    state.agents[threadId] = {
      conversationId: child.id,
      description,
      placement: { kind: placement.kind, ...(placement.kind === "device" ? { deviceId: placement.deviceId } : {}) },
      reported: [],
      ...(args.origin ? { origin: args.origin } : {}),
    };
    if (args.detached) {
      state.calls[args.callKey] = { threadId, reporter: -1 };
      return { threadId, existing: false };
    }
    const reporter = await tx.createTask(
      Reporter,
      { threadId, conversationId: child.id, message: args.prompt },
      { ownership: { kind: "conversation" }, background: true, conversationId: parentConversationId },
    );
    state.calls[args.callKey] = { threadId, reporter };
    return { threadId, existing: false };
  };

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
      // Another Stella alias only for a caller on Stella's models: a turn on
      // the user's own model or plan is admitted for that model alone.
      const runsOn =
        requested?.startsWith("stella/") && callerAgent.model?.provider === STELLA_PROVIDER_ID
          ? { model: { provider: STELLA_PROVIDER_ID, modelId: stellaModelId("general", requested) } }
          : childRun(callerAgent);
      const description = args.description.trim() || "agent";
      const remote = host.remote?.(placement);
      if (remote) {
        // Its report comes back to the orchestrator only.
        if (caller.agentType !== "orchestrator") throw new Error("Only Stella can start an agent somewhere else; run this one here.");
        const callKey = String(api.taskId);
        const prior = (await api.snapshot(StellaAgentsDoc, api.conversationId, context))?.calls[callKey];
        const threadId =
          prior?.threadId ?? (await remote.start({ key: `spawn:${callKey}`, description, prompt: args.prompt }, context)).threadId;
        await api.commit(async (tx) => {
          const state = await tx.doc(StellaAgentsDoc, api.conversationId);
          if (state.calls[callKey]) return;
          state.agents[threadId] = {
            conversationId: -1,
            description,
            placement: { kind: placement.kind, ...(placement.kind === "device" ? { deviceId: placement.deviceId } : {}) },
            reported: [],
            remote: true,
            startedAt: Date.now(),
          };
          state.calls[callKey] = { threadId, reporter: -1 };
        }, context);
        await api.details({ thread_id: threadId }, context);
        return {
          content: [
            {
              type: "text",
              text: `${prior ? "Already started" : "Started"} ${threadId} (${describePlacement(placement)}). thread_id: ${threadId}. Its report arrives in [Agent completed].`,
            },
          ],
          details: { thread_id: threadId },
        };
      }
      const { threadId, existing } = await api.commit(
        (tx) =>
          createAgent(tx, {
            parentConversationId: api.conversationId,
            callKey: String(api.taskId),
            depth,
            description,
            prompt: args.prompt,
            runsOn,
            placement,
          }),
        context,
      );
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
      const known = (await api.snapshot(StellaAgentsDoc, api.conversationId, context))?.agents[threadId];
      const remote = known?.remote ? remoteHostOf(known) : undefined;
      if (known?.remote) {
        if (!remote) throw new Error(`${threadId} runs where this conversation cannot reach it now.`);
        await remote.message({ key: `message:${api.taskId}`, threadId, message: args.message }, context);
        await expectRemoteReport(api, api.conversationId, String(api.taskId), threadId, context);
        return { content: [{ type: "text", text: `Delivered to ${threadId}.` }] };
      }
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

  /** A message given to a remote agent is answered by a report like its start, so it counts until one comes back. */
  const expectRemoteReport = (
    on: { commit: Harness["commit"] },
    conversationId: ConversationId,
    callKey: string,
    threadId: string,
    context: Context,
  ) =>
    on.commit(async (tx) => {
      const state = await tx.doc(StellaAgentsDoc, conversationId);
      state.calls[callKey] ??= { threadId, reporter: -1 };
    }, context);

  const remoteHostOf = (agent: AgentRecord): RemoteAgentHost | undefined => {
    const placement = placementOf(agent.placement);
    return placement ? host.remote?.(placement) : undefined;
  };

  const status = async (api: ToolExecutionApi, threadId: string, agent: AgentRecord, context: Context, detailed: boolean) => {
    if (agent.remote) {
      const where = describePlacement(placementOf(agent.placement) ?? host.rootPlacement);
      const there = await remoteHostOf(agent)
        ?.status?.(threadId, context)
        .catch(() => undefined);
      return `- ${threadId}: ${agent.description} [${where}] ${there ?? "runs there; its report arrives in [Agent completed]"}`;
    }
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
      if (agent.remote) {
        const pause = remoteHostOf(agent)?.pause;
        if (!pause) throw new Error(`${threadId} cannot be paused from here.`);
        await pause(threadId, context);
        return { content: [{ type: "text", text: `Paused ${threadId}.` }] };
      }
      const handle = await api.conversation(agent.conversationId as ConversationId, context);
      await handle?.abort(context);
      return { content: [{ type: "text", text: `Paused ${threadId}.` }] };
    },
  });

  /**
   * Start an agent the host asked for rather than a tool call (an app-source
   * merge, memory sync): under the orchestrator, at depth 1, reporting to it
   * like a spawned agent. Once per `key`.
   */
  const startAgent = async (
    harness: Harness,
    args: {
      key: string;
      description: string;
      prompt: string;
      /** The thread id another host chose for it. */
      threadId?: string;
      /** Started for another host's orchestrator, which gets its reports. */
      origin?: { deviceId: string };
    },
    context: Context,
  ): Promise<{ threadId: string; existing: boolean }> => {
    const root = await harness.root(context);
    const runsOn = childRun(await root.agent(context));
    return await harness.commit(
      (tx) =>
        createAgent(tx, {
          parentConversationId: root.id,
          callKey: `host:${args.key}`,
          depth: 1,
          description: args.description.trim() || "agent",
          prompt: args.prompt,
          runsOn,
          placement: host.rootPlacement,
          ...(args.threadId ? { threadId: args.threadId } : {}),
          ...(args.origin ? { origin: args.origin } : {}),
        }),
      context,
    );
  };

  /** Pause one of the orchestrator's agents by thread id (for the host that started it). */
  const pauseAgentByThread = async (harness: Harness, threadId: string, context: Context): Promise<void> => {
    const root = await harness.root(context);
    const agent = (await harness.snapshot(StellaAgentsDoc, root.id, context))?.agents[threadId];
    if (!agent || agent.remote) throw new Error(`No agent ${threadId} here.`);
    await (await harness.conversation(agent.conversationId as ConversationId, context))?.abort(context);
  };

  /**
   * The orchestrator's agents as the app lists them: each one's status,
   * description, start and latest activity, and its latest prose.
   */
  const agentRecords = async (harness: Harness, context: Context): Promise<StellaAgentRecord[]> => {
    const root = await harness.root(context);
    const state = await harness.snapshot(StellaAgentsDoc, root.id, context);
    const records: StellaAgentRecord[] = [];
    // An agent that runs elsewhere is done once a report came back for each
    // message it was given; what it said is what its reports carried.
    const remoteAgents = Object.entries(state?.agents ?? {}).filter(([, agent]) => agent.remote);
    const reports =
      remoteAgents.length === 0
        ? []
        : (await harness.commit(async (tx) => (await tx.scanEntries({ conversationId: root.id, order: "descending" }, 300)).items, context))
            .filter((entry) => entry.kind === "pi.user")
            .map((entry) => ({ entry, text: messageText(entry.model?.[0]) }))
            .filter(({ text }) => /^\[(Agent completed|Task failed|Task canceled)\]/.test(text.trimStart()));
    for (const [threadId, agent] of remoteAgents) {
      const given = Object.values(state?.calls ?? {}).filter((call) => call.threadId === threadId).length;
      // Newest first, as scanned.
      const back = reports.filter(({ text }) => text.includes(`\nthread_id: ${threadId}\n`));
      const at = (back[0]?.entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp;
      const said = back
        .map(({ text }) => /\n(?:result|error): ([\s\S]*?)(?=\n(?:agent_state|routing|presentation): |$)/.exec(text)?.[1]?.trim() ?? "")
        .filter((text) => text && text !== "(no reply)")
        .reverse()
        .slice(-5);
      records.push({
        threadId,
        description: agent.description,
        placement: agent.placement,
        status: (agent.answered?.length ?? 0) >= given ? (agent.failed ? "error" : "completed") : "running",
        startedAt: agent.startedAt ?? at ?? Date.now(),
        updatedAt: at ?? agent.startedAt ?? Date.now(),
        assistantMessages: said,
      });
    }
    for (const [threadId, agent] of Object.entries(state?.agents ?? {})) {
      if (agent.remote) continue;
      const conversationId = agent.conversationId as ConversationId;
      const [live, [first, recent]] = await Promise.all([
        harness.snapshot(LiveDoc, conversationId, context),
        harness.commit(
          async (tx) =>
            [
              (await tx.scanEntries({ conversationId, order: "ascending" }, 1)).items[0],
              (await tx.scanEntries({ conversationId, order: "descending" }, 40)).items,
            ] as const,
          context,
        ),
      ]);
      const answers = recent
        .filter((entry) => entry.kind === "pi.assistant")
        .map((entry) => entry.model?.[0] as AssistantMessage | undefined)
        .filter((message): message is AssistantMessage => message !== undefined);
      const latest = answers[0];
      const prose = answers.map(textOf).filter((text) => text.trim()).reverse().slice(-5);
      const oldest = first?.model?.[0] as { timestamp?: number } | undefined;
      const running = live?.run !== undefined;
      records.push({
        threadId,
        description: agent.description,
        placement: agent.placement,
        status: running ? "running" : latest?.stopReason === "error" ? "error" : "completed",
        startedAt: oldest?.timestamp ?? latest?.timestamp ?? Date.now(),
        updatedAt: latest?.timestamp ?? oldest?.timestamp ?? Date.now(),
        assistantMessages: prose,
        ...(latest?.stopReason === "error" && latest.errorMessage ? { error: latest.errorMessage } : {}),
      });
    }
    return records;
  };

  /**
   * A message from the user to one of the orchestrator's agents, carried
   * like `send_message`: a reporter delivers it and reports the answer up.
   * Once per `key`.
   */
  const messageAgent = async (
    harness: Harness,
    args: {
      key: string;
      threadId: string;
      message: string;
      /** The orchestrator that started it wrote this, not the user in its thread. */
      fromOrchestrator?: boolean;
    },
    context: Context,
  ): Promise<void> => {
    const root = await harness.root(context);
    const known = (await harness.snapshot(StellaAgentsDoc, root.id, context))?.agents[args.threadId];
    if (known?.remote) {
      const remote = remoteHostOf(known);
      if (!remote) throw new Error(`${args.threadId} runs where this conversation cannot reach it now.`);
      await remote.message({ key: `user:${args.key}`, threadId: args.threadId, message: args.message }, context);
      await expectRemoteReport(harness, root.id, `user:${args.key}`, args.threadId, context);
      return;
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(StellaAgentsDoc, root.id);
      const callKey = `user:${args.key}`;
      if (state.calls[callKey]) return undefined;
      const agent = state.agents[args.threadId];
      if (!agent) throw new Error(`No agent ${args.threadId} here.`);
      const reporter = await tx.createTask(
        Reporter,
        {
          threadId: args.threadId,
          conversationId: agent.conversationId,
          message: args.message,
          ...(args.fromOrchestrator ? {} : { fromUser: true as const }),
        },
        { ownership: { kind: "conversation" }, background: true, conversationId: root.id },
      );
      state.calls[callKey] = { threadId: args.threadId, reporter };
      return undefined;
    }, context);
  };

  /**
   * Run an agent another host placed here (a cloud orchestrator's agent on
   * this computer): under the orchestrator at depth 1, answering its brief
   * to the host that placed it rather than reporting here. Once per `key`;
   * settles with its answer.
   */
  const runPlacedAgent = async (harness: Harness, args: PlacedAgentRun, context: Context): Promise<PlacedAgentResult> => {
    const root = await harness.root(context);
    const runsOn = childRun(await root.agent(context));
    const { threadId } = await harness.commit(
      (tx) =>
        createAgent(tx, {
          parentConversationId: root.id,
          callKey: `placed:${args.agentKey}`,
          depth: 1,
          description: args.description.trim() || "agent",
          prompt: args.prompt,
          runsOn,
          placement: host.rootPlacement,
          detached: true,
        }),
      context,
    );
    const record = (await harness.snapshot(StellaAgentsDoc, root.id, context))?.agents[threadId];
    const agent = record ? await harness.conversation(record.conversationId as ConversationId, context) : undefined;
    if (!agent) return { threadId, status: "error", error: "The agent could not start here." };
    if (args.signal?.aborted) return { threadId, status: "error", error: "Canceled." };
    const submission = await agent.submit(
      { type: "input", content: args.prompt, whenBusy: "steer", requestId: `placed:${args.runKey}` },
      context,
    );
    const stop = async () => {
      const withdrawn = await harness.abortSubmission(submission.id, context, agent.id);
      if (withdrawn === "already_placed") await agent.abort(context);
    };
    args.signal?.addEventListener("abort", () => void stop().catch(() => undefined), { once: true });
    if (args.signal?.aborted) await stop();
    const settled = await submission.wait(context);
    if (args.signal?.aborted) return { threadId, status: "error", error: "Canceled." };
    if (settled.status !== "done" || settled.type !== "input") {
      return { threadId, status: "error", error: settled.status === "unanswered" ? settled.reason : "The agent did not answer." };
    }
    const answer = await harness.commit(async (tx) => tx.entry(AssistantEntry, settled.answer), context);
    const message = answer?.model?.[0] as AssistantMessage | undefined;
    if (message?.stopReason === "error") return { threadId, status: "error", error: message.errorMessage ?? "The agent failed." };
    return { threadId, status: "ok", finalText: textOf(message) };
  };

  /** A message for an agent another host placed here, from that host; it reads it before its next step. */
  const steerPlacedAgent = async (
    harness: Harness,
    args: { key: string; agentKey: string; message: string },
    context: Context,
  ): Promise<boolean> => {
    const root = await harness.root(context);
    const state = await harness.snapshot(StellaAgentsDoc, root.id, context);
    const threadId = state?.calls[`placed:${args.agentKey}`]?.threadId;
    const record = threadId ? state?.agents[threadId] : undefined;
    const agent = record && !record.remote ? await harness.conversation(record.conversationId as ConversationId, context) : undefined;
    if (!agent) return false;
    await agent.submit({ type: "input", content: args.message, whenBusy: "steer", requestId: `steer:${args.key}` }, context);
    return true;
  };

  const extension = defineExtension({
    name: STELLA_AGENTS_EXTENSION,
    tasks: [Anchor, Reporter],
    tools: [spawnAgent, sendMessage, agentStatus, pauseAgent],
  });
  return {
    extension,
    startAgent,
    agentRecords,
    messageAgent,
    pauseAgentByThread,
    runPlacedAgent,
    steerPlacedAgent,
  };
}

export const stellaAgentsExtension = (host: StellaAgentsHost) => stellaAgents(host).extension;

export type { TaskId, EntryId };
