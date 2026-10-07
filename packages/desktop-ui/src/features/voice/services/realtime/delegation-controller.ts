/**
 * Client delegation: GPT-Live asks, Stella's text orchestrator answers.
 *
 * `session.delegation.created` carries `delegation.id`, `delegation.target`
 * and `offset_ms` and deliberately contains NO task text — the voice model has
 * decided that the backend should handle the current request, and it is our
 * job to say what that request was. The request is therefore built here from
 * the accumulated transcript plus session state.
 *
 * The work itself runs through the bridge that already existed for voice:
 * `voice.orchestratorChat` → `VoiceRuntimeService.orchestratorChat` →
 * `handleLocalChat({ agentType: "orchestrator" })`. That path already queues,
 * persists to the journal, and emits tool and lifecycle events, so nothing
 * about the orchestrator's own behaviour changes for a voice-originated turn.
 *
 * Two rules that the two-brain design makes easy to get wrong:
 *
 *   - **Interrupting speech does not cancel backend work.** Barge-in stops the
 *     model talking; the orchestrator keeps going. The task is tracked here so
 *     a later delegation cannot start the same work twice.
 *   - **A changed request supersedes the old one.** The superseded task's
 *     result is dropped rather than spoken, because the user has moved on.
 */

import type { SessionAppendChannel } from "./session-append-channel";
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

export type DelegationControllerEvents = {
  onToolStart: (name: string, callId: string) => void;
  onToolEnd: (name: string, callId: string, result: string) => void;
};

export type DelegationControllerDeps = {
  appends: SessionAppendChannel;
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

type ActiveTask = {
  delegationId: string;
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
  private readonly handledDelegationIds = new Set<string>();
  private lastDelegatedRequest = "";
  private disposed = false;

  constructor(deps: DelegationControllerDeps) {
    this.deps = deps;
    this.unsubscribeActivity = deps.subscribeActivity((activity) => {
      this.handleActivity(activity);
    });
  }

  /** The delegation id an unsolicited context append should be filed under. */
  get activeDelegationId(): string | null {
    return this.active?.delegationId ?? null;
  }

  get isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Handle `session.delegation.created`. Returns false when the event was not
   * a delegation (or was a duplicate), so the caller can keep routing.
   */
  handleEvent(event: Record<string, unknown>): boolean {
    if (event.type !== "session.delegation.created") return false;

    const delegation =
      typeof event.delegation === "object" && event.delegation !== null
        ? (event.delegation as Record<string, unknown>)
        : {};
    const delegationId =
      typeof delegation.id === "string" && delegation.id.trim()
        ? delegation.id.trim()
        : "";
    if (!delegationId) {
      console.debug("[gpt-live] Delegation created without an id; ignoring.");
      return true;
    }
    if (this.handledDelegationIds.has(delegationId)) {
      return true;
    }
    this.handledDelegationIds.add(delegationId);

    const target =
      typeof delegation.target === "string" ? delegation.target.trim() : "";
    const offsetMs =
      typeof event.offset_ms === "number" && Number.isFinite(event.offset_ms)
        ? event.offset_ms
        : null;

    void this.run(delegationId, target, offsetMs);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.active = null;
    this.handledDelegationIds.clear();
    this.lastDelegatedRequest = "";
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * The delegation event has no task text, so the request is the user's
   * recent speech. The newest utterance is the ask; the ones before it are
   * context for pronouns and follow-ups ("do that too", "the second one").
   */
  private buildRequest(target: string, offsetMs: number | null): string {
    // Close whatever is still open so the sentence that triggered the
    // delegation is part of the request rather than stranded mid-run.
    this.deps.transcript.flush();
    const turns = this.deps.transcript.recentUserTurns(RECENT_USER_TURNS);
    const latest = turns[turns.length - 1]?.text.trim() ?? "";
    const earlier = turns
      .slice(0, -1)
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0);

    const lines: string[] = [];
    lines.push(
      "This request came in through Stella's live voice call. The user is on the line and waiting to hear the answer out loud, so answer it as Stella would and keep the result short enough to be spoken.",
    );
    if (earlier.length > 0) {
      lines.push(
        `Earlier in this call the user said: ${earlier
          .map((text) => `"${text}"`)
          .join(" then ")}`,
      );
    }
    lines.push(
      latest
        ? `The user's request is: "${latest}"`
        : "The user asked for something the transcript did not capture. Ask them to repeat it rather than guessing.",
    );
    if (target) {
      lines.push(`The voice model routed this to: ${target}.`);
    }
    if (offsetMs !== null) {
      lines.push(
        `It was raised ${Math.max(0, Math.round(offsetMs / 1000))}s into the call.`,
      );
    }
    const request = lines.join("\n");
    return request.length > MAX_REQUEST_CHARS
      ? request.slice(0, MAX_REQUEST_CHARS)
      : request;
  }

  private async run(
    delegationId: string,
    target: string,
    offsetMs: number | null,
  ): Promise<void> {
    if (this.disposed) return;
    const conversationId = this.deps.getConversationId();
    if (!conversationId) {
      this.deps.appends.append(
        "thinking",
        "Stella's backend is not attached to a conversation right now, so this could not be delegated. Tell the user you cannot act on it yet.",
        delegationId,
      );
      return;
    }

    const request = this.buildRequest(target, offsetMs);

    // A new delegation while one is in flight means the user changed the ask.
    // The old task keeps running (we cannot cancel it) but its result is no
    // longer what the user wants to hear.
    if (this.active) {
      this.active.superseded = true;
    }

    this.generation += 1;
    const generation = this.generation;
    const requestId = `voice-delegation:${delegationId}`;
    const task: ActiveTask = {
      delegationId,
      requestId,
      generation,
      request,
      superseded: false,
    };
    this.active = task;
    this.lastDelegatedRequest = request;
    this.deps.appends.resetProgressThrottle();
    this.deps.appends.append(
      "thinking",
      "Stella's backend is handling this now. Do not claim it is done until the result arrives.",
      delegationId,
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
      this.deps.appends.append(
        "commentary",
        text ||
          "The backend finished but returned nothing to report. Tell the user it is done.",
        delegationId,
      );
    } catch (error) {
      if (this.disposed || task.superseded || generation !== this.generation) {
        return;
      }
      const message = (error as Error).message?.trim() ?? "";
      if (/superseded/i.test(message)) {
        return;
      }
      this.deps.appends.append(
        "commentary",
        `That did not go through. ${message || "The backend did not say why."} Tell the user briefly and offer to try again.`,
        delegationId,
      );
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  /**
   * Forward the orchestrator's own progress so the voice model can say what is
   * happening instead of inventing it. Tool cards still reach the overlay
   * through the session's own event stream.
   */
  private handleActivity(activity: VoiceOrchestratorActivity): void {
    const task = this.active;
    if (!task || activity.requestId !== task.requestId) return;

    if (activity.kind === "tool-start") {
      const name = activity.toolName ?? "";
      if (name && activity.toolCallId) {
        this.deps.events.onToolStart(name, activity.toolCallId);
      }
      if (this.deps.isInputActive()) {
        this.deps.appends.appendProgress(
          `Stella's backend is using ${describeTool(name)}.`,
          task.delegationId,
        );
      }
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
    if (statusText && this.deps.isInputActive()) {
      this.deps.appends.appendProgress(
        `Backend progress: ${statusText}`,
        task.delegationId,
      );
    }
  }

  /** The request text of the task currently in flight, for diagnostics. */
  get pendingRequest(): string {
    return this.active ? this.active.request : this.lastDelegatedRequest;
  }
}
