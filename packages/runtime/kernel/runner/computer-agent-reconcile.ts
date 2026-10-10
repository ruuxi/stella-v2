/**
 * The computer's half of keeping the cloud's record of its agents exact.
 *
 * The owner's agent threads list every agent this computer runs for a
 * conversation stored in the cloud, and the conversation's journal follows
 * them (the owner posts each attempt's start and end there), which is what a
 * paired phone counts as running. An agent this computer stopped without
 * telling them stays "running" there for good: a crash or a kill mid-run, or
 * a pause from a build that never reported one. So on every start and
 * reconnect, each agent the records say runs here and does not is settled
 * with how it actually ended, or as interrupted when nothing here knows it.
 *
 * An agent that resumes after a restart (pi-durable picks its run back up)
 * reads as running and is left alone.
 */

/** How one agent stands on this computer. `attempt` is the newest one it started. */
export type ComputerAgentStanding = {
  status: "running" | "completed" | "error" | "canceled";
  attempt: number;
  /** Why it stopped short, for a canceled or failed one. */
  error?: string;
};

type RunningComputerThread = {
  threadId: string;
  conversationId: string;
  attemptGeneration: number;
};

export const INTERRUPTED_AGENT_REASON =
  "Interrupted: this computer is no longer running this agent.";

export const reconcileComputerAgents = async (args: {
  /** `computerThreads.running` for this computer. */
  running(): Promise<RunningComputerThread[]>;
  /** `computerThreads.complete` / `computerThreads.cancel`, fenced on the attempt. */
  complete(input: {
    threadId: string;
    attemptGeneration: number;
    status: "completed" | "failed" | "canceled";
    error?: string;
  }): Promise<unknown>;
  cancel(input: { threadId: string; attemptGeneration: number; reason: string }): Promise<unknown>;
  /** How the agent stands here; undefined when nothing on this computer knows it. */
  standing(threadId: string): Promise<ComputerAgentStanding | undefined>;
}): Promise<{ settled: string[] }> => {
  const settled: string[] = [];
  for (const thread of await args.running()) {
    const here = await args.standing(thread.threadId);
    if (here?.status === "running") continue;
    // A newer attempt than the records know is still on its way to them,
    // with its own start and end.
    if (here && here.attempt > thread.attemptGeneration) continue;
    if (!here) {
      await args.cancel({
        threadId: thread.threadId,
        attemptGeneration: thread.attemptGeneration,
        reason: INTERRUPTED_AGENT_REASON,
      });
    } else {
      await args.complete({
        threadId: thread.threadId,
        attemptGeneration: thread.attemptGeneration,
        status: here.status === "error" ? "failed" : here.status,
        ...(here.status !== "completed"
          ? { error: here.error?.trim() || INTERRUPTED_AGENT_REASON }
          : {}),
      });
    }
    settled.push(thread.threadId);
  }
  return { settled };
};
