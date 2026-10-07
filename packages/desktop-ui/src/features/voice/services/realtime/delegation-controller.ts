/**
 * Client delegation: the voice model asks, Stella's text orchestrator answers.
 *
 * One controller serves both protocols, because the work is identical and only
 * the two ends differ:
 *
 *   - **How the request arrives.** GPT-Live sends
 *     `session.delegation.created`, which carries `delegation.id`,
 *     `delegation.target` and `offset_ms` and deliberately NO task text — the
 *     model has decided the backend should handle the current request, and it
 *     is our job to say what that was. The Realtime routes (OpenAI BYOK, xAI)
 *     instead call the single `ask_stella` function, which does state the
 *     request. Either way the transcript supplies the surrounding context.
 *   - **How the result goes back.** That is the `DelegationChannel`:
 *     commentary/thinking appends on GPT-Live, `function_call_output` plus
 *     `response.create` on Realtime.
 *
 * The work itself always runs through the bridge that already existed for
 * voice: `voice.orchestratorChat` → `VoiceRuntimeService.orchestratorChat` →
 * `handleLocalChat({ agentType: "orchestrator" })`, which queues, persists to
 * the journal, and emits tool and lifecycle events.
 *
 * Two rules the two-brain design makes easy to get wrong:
 *
 *   - **Interrupting speech does not cancel backend work.** Barge-in stops the
 *     model talking; the orchestrator keeps going. The task is tracked here so
 *     a later request cannot start the same work twice.
 *   - **A changed request supersedes the old one.** The superseded task is
 *     completed on its channel immediately — a Realtime function call left
 *     unanswered would wedge the conversation — but its eventual result is
 *     dropped rather than spoken, because the user has moved on.
 */

import {
  ASK_STELLA_TOOL_NAME,
  parseAskStellaRequest,
} from "./ask-stella-tool";
import type { TranscriptAccumulator } from "./transcript-accumulator";

/** Progress forwarded from the orchestrator's own run, over IPC. */
export type VoiceOrchestratorActivity = {
  requestId: string;
  kind: "status" | "tool-start" | "tool-end";
  statusText?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export type DelegationOutcome = {
  kind: "result" | "failure" | "superseded";
  text: string;
};

/**
 * How one protocol returns delegated work. `taskId` is the GPT-Live
 * delegation id or the Realtime function call id.
 */
export type DelegationChannel = {
  /** Context at task start. Omitted where the protocol has no quiet channel. */
  announceStart?: (taskId: string, request: string) => void;
  /** In-flight progress. Omitted where the protocol has no quiet channel. */
  reportProgress?: (taskId: string, text: string) => void;
  /** Terminal. Must answer the task on protocols that expect a reply. */
  complete: (taskId: string, outcome: DelegationOutcome) => void;
};

export type DelegationControllerEvents = {
  onToolStart: (name: string, callId: string) => void;
  onToolEnd: (name: string, callId: string, result: string) => void;
};

export type DelegationControllerDeps = {
  channel: DelegationChannel;
  transcript: TranscriptAccumulator;
  getConversationId: () => string | null;
  /** True while the user's live voice turn is active. */
  isInputActive: () => boolean;
  runOrchestrator: (args: {
    requestId: string;
    conversationId: string;
    message: string;
  }) => Promise<string>;
  subscribeActivity: (
    handler: (activity: VoiceOrchestratorActivity) => void,
  ) => () => void;
  events: DelegationControllerEvents;
};

const RECENT_USER_TURNS = 3;
const MAX_REQUEST_CHARS = 4_000;
/** Progress notes are a courtesy, not a feed. One every this often, at most. */
const PROGRESS_MIN_INTERVAL_MS = 1_200;

type DelegationStart = {
  taskId: string;
  /** What the model said it wants, when the protocol lets it say so. */
  statedRequest?: string;
  target?: string;
  offsetMs?: number | null;
};

type ActiveTask = {
  taskId: string;
  requestId: string;
  generation: number;
  request: string;
  superseded: boolean;
};

const describeTool = (name: string): string => {
  const readable = name.replace(/[_:]+/g, " ").trim();
  return readable || "a tool";
};

export class DelegationController {
  private readonly deps: DelegationControllerDeps;
  private unsubscribeActivity: (() => void) | null = null;
  private generation = 0;
  private active: ActiveTask | null = null;
  private readonly handledTaskIds = new Set<string>();
  private lastDelegatedRequest = "";
  private lastProgressAt = 0;
  private disposed = false;

  constructor(deps: DelegationControllerDeps) {
    this.deps = deps;
    this.unsubscribeActivity = deps.subscribeActivity((activity) => {
      this.handleActivity(activity);
    });
  }

  /** The task an unsolicited context append should be filed under. */
  get activeDelegationId(): string | null {
    return this.active?.taskId ?? null;
  }

  get isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * GPT-Live's delegation event. Returns false when the event was something
   * else, so the caller can keep routing.
   */
  handleDelegationEvent(event: Record<string, unknown>): boolean {
    if (event.type !== "session.delegation.created") return false;

    const delegation =
      typeof event.delegation === "object" && event.delegation !== null
        ? (event.delegation as Record<string, unknown>)
        : {};
    const taskId =
      typeof delegation.id === "string" && delegation.id.trim()
        ? delegation.id.trim()
        : "";
    if (!taskId) {
      console.debug("[voice-delegation] Delegation created without an id.");
      return true;
    }

    this.begin({
      taskId,
      target:
        typeof delegation.target === "string"
          ? delegation.target.trim()
          : undefined,
      offsetMs:
        typeof event.offset_ms === "number" && Number.isFinite(event.offset_ms)
          ? event.offset_ms
          : null,
    });
    return true;
  }

  /**
   * A Realtime `ask_stella` call. Both event shapes land here: OpenAI reports
   * the completed call inside `response.output_item.done`, xAI emits
   * `response.function_call_arguments.done` at the top level, and a provider
   * may send both for the same call — the task id dedupe covers that.
   */
  handleFunctionCallEvent(event: Record<string, unknown>): boolean {
    const call = readFunctionCall(event);
    if (!call) return false;
    if (call.name !== ASK_STELLA_TOOL_NAME) {
      console.debug(
        "[voice-delegation] Ignoring an unexpected voice tool call:",
        call.name,
      );
      return true;
    }
    if (!call.callId) {
      console.debug("[voice-delegation] Tool call arrived without a call id.");
      return true;
    }

    this.begin({
      taskId: call.callId,
      statedRequest: parseAskStellaRequest(call.arguments),
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.active = null;
    this.handledTaskIds.clear();
    this.lastDelegatedRequest = "";
    this.lastProgressAt = 0;
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
  }

  // ── internals ────────────────────────────────────────────────────────

  private begin(start: DelegationStart): void {
    if (this.handledTaskIds.has(start.taskId)) return;
    this.handledTaskIds.add(start.taskId);
    void this.run(start);
  }

  /**
   * The request the orchestrator receives. On GPT-Live there is no task text
   * at all, so the user's recent speech IS the request; on Realtime the model
   * states it and the speech around it disambiguates pronouns and follow-ups
   * ("do that too", "the second one").
   */
  private buildRequest(start: DelegationStart): string {
    // Close whatever is still open so the sentence that triggered this is part
    // of the request rather than stranded mid-run.
    this.deps.transcript.flush();
    const turns = this.deps.transcript.recentUserTurns(RECENT_USER_TURNS);
    const spoken = turns
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0);
    const latest = spoken[spoken.length - 1] ?? "";
    const stated = start.statedRequest?.trim() ?? "";

    const lines: string[] = [];
    lines.push(
      "This request came in through Stella's live voice call. The user is on the line and waiting to hear the answer out loud, so answer it as Stella would and keep the result short enough to be spoken.",
    );

    if (stated) {
      lines.push(`The request is: "${stated}"`);
      if (spoken.length > 0) {
        lines.push(
          `For context, the user's recent words on the call were: ${spoken
            .map((text) => `"${text}"`)
            .join(" then ")}`,
        );
      }
    } else if (latest) {
      const earlier = spoken.slice(0, -1);
      if (earlier.length > 0) {
        lines.push(
          `Earlier in this call the user said: ${earlier
            .map((text) => `"${text}"`)
            .join(" then ")}`,
        );
      }
      lines.push(`The user's request is: "${latest}"`);
    } else {
      lines.push(
        "The user asked for something the transcript did not capture. Ask them to repeat it rather than guessing.",
      );
    }

    if (start.target) {
      lines.push(`The voice model routed this to: ${start.target}.`);
    }
    if (typeof start.offsetMs === "number") {
      lines.push(
        `It was raised ${Math.max(0, Math.round(start.offsetMs / 1000))}s into the call.`,
      );
    }
    const request = lines.join("\n");
    return request.length > MAX_REQUEST_CHARS
      ? request.slice(0, MAX_REQUEST_CHARS)
      : request;
  }

  private async run(start: DelegationStart): Promise<void> {
    if (this.disposed) return;
    const { taskId } = start;
    const conversationId = this.deps.getConversationId();
    if (!conversationId) {
      this.deps.channel.complete(taskId, {
        kind: "failure",
        text: "Stella's backend is not attached to a conversation right now, so this could not be run. Tell the user you cannot act on it yet.",
      });
      return;
    }

    const request = this.buildRequest(start);

    // A new request while one is in flight means the user changed their mind.
    // The old task keeps running — it cannot be cancelled — but its result is
    // no longer what the user wants to hear, and on Realtime its function call
    // still has to be answered or the conversation stalls.
    const previous = this.active;
    if (previous) {
      previous.superseded = true;
      this.deps.channel.complete(previous.taskId, {
        kind: "superseded",
        text: "Superseded: the user changed the request before this finished. Do not report this one.",
      });
    }

    this.generation += 1;
    const generation = this.generation;
    const requestId = `voice-delegation:${taskId}`;
    const task: ActiveTask = {
      taskId,
      requestId,
      generation,
      request,
      superseded: false,
    };
    this.active = task;
    this.lastDelegatedRequest = request;
    this.lastProgressAt = 0;
    this.deps.channel.announceStart?.(
      taskId,
      "Stella's backend is handling this now. Do not claim it is done until the result arrives.",
    );

    try {
      const result = await this.deps.runOrchestrator({
        requestId,
        conversationId,
        message: request,
      });
      if (this.disposed || task.superseded || generation !== this.generation) {
        return;
      }
      const text = result.trim();
      this.deps.channel.complete(taskId, {
        kind: "result",
        text:
          text ||
          "The backend finished but returned nothing to report. Tell the user it is done.",
      });
    } catch (error) {
      if (this.disposed || task.superseded || generation !== this.generation) {
        return;
      }
      const message = (error as Error).message?.trim() ?? "";
      if (/superseded/i.test(message)) return;
      this.deps.channel.complete(taskId, {
        kind: "failure",
        text: `That did not go through. ${message || "The backend did not say why."} Tell the user briefly and offer to try again.`,
      });
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  /**
   * Forward the orchestrator's own progress so the voice model can say what is
   * happening instead of inventing it, rate-limited so the session is not
   * flooded. Tool cards still reach the overlay through the session's events.
   */
  private handleActivity(activity: VoiceOrchestratorActivity): void {
    const task = this.active;
    if (!task || activity.requestId !== task.requestId) return;

    if (activity.kind === "tool-start") {
      const name = activity.toolName ?? "";
      if (name && activity.toolCallId) {
        this.deps.events.onToolStart(name, activity.toolCallId);
      }
      this.reportProgress(task, `Stella's backend is using ${describeTool(name)}.`);
      return;
    }

    if (activity.kind === "tool-end") {
      const name = activity.toolName ?? "";
      if (name && activity.toolCallId) {
        this.deps.events.onToolEnd(
          name,
          activity.toolCallId,
          activity.isError ? "error" : "ok",
        );
      }
      return;
    }

    const statusText = activity.statusText?.trim();
    if (statusText) this.reportProgress(task, `Backend progress: ${statusText}`);
  }

  private reportProgress(task: ActiveTask, text: string): void {
    if (!this.deps.channel.reportProgress) return;
    if (!this.deps.isInputActive()) return;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.deps.channel.reportProgress(task.taskId, text);
  }

  /** The request text of the task currently in flight, for diagnostics. */
  get pendingRequest(): string {
    return this.active ? this.active.request : this.lastDelegatedRequest;
  }
}

const readFunctionCall = (
  event: Record<string, unknown>,
): { name: string; callId: string; arguments: unknown } | null => {
  if (event.type === "response.function_call_arguments.done") {
    return {
      name: typeof event.name === "string" ? event.name.trim() : "",
      callId: typeof event.call_id === "string" ? event.call_id.trim() : "",
      arguments: event.arguments,
    };
  }
  if (event.type !== "response.output_item.done") return null;
  const item =
    typeof event.item === "object" && event.item !== null
      ? (event.item as Record<string, unknown>)
      : null;
  if (!item || item.type !== "function_call") return null;
  return {
    name: typeof item.name === "string" ? item.name.trim() : "",
    callId: typeof item.call_id === "string" ? item.call_id.trim() : "",
    arguments: item.arguments,
  };
};
