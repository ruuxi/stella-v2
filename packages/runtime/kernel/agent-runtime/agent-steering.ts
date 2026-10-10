import { persistThreadPayloadMessage } from "./thread-memory.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";

/** The engine-neutral live agent a Claude Code turn exposes (`createExternalLiveAgent`). */
type SteerableLiveAgent = {
  state: { isStreaming: boolean };
  steer: (message: AgentMessage) => void;
};

type SteeringRun = {
  store: RuntimeStore;
  runId: string;
  attemptGeneration?: number;
};

/**
 * Steering for one agent thread. `LocalAgentManager` keeps one per thread;
 * each Claude Code turn attaches its live agent while it runs, so a
 * `send_message` reaches the agent mid-turn instead of waiting for the next.
 */
export class AgentSteering {
  private live: { agent: SteerableLiveAgent; run: SteeringRun } | null = null;

  /** The agent's thread is keyed by its thread id. */
  constructor(readonly threadKey: string) {}

  get canSteer(): boolean {
    return this.live?.agent.state.isStreaming === true;
  }

  /** Persists the message to the thread, then hands it to the running turn. */
  steer(text: string): boolean {
    const prompt = text.trim();
    const live = this.live;
    if (!prompt || !live || !this.canSteer) return false;
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };
    persistThreadPayloadMessage(live.run.store, {
      threadKey: this.threadKey,
      payload: message,
      runId: live.run.runId,
      ...(typeof live.run.attemptGeneration === "number"
        ? { attemptGeneration: live.run.attemptGeneration }
        : {}),
    });
    live.agent.steer(message);
    return true;
  }

  /** Attach a turn's live agent; the returned function detaches it. */
  attach(agent: SteerableLiveAgent, run: SteeringRun): () => void {
    const live = { agent, run };
    this.live = live;
    return () => {
      if (this.live === live) this.live = null;
    };
  }
}
