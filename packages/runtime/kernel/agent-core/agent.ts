import { getModel } from "../../ai/models.js";
import type { AgentState } from "./types.js";
import {
  ExplicitModelAgent,
  type AgentOptions,
} from "./explicit-model-agent.js";

export type { AgentOptions } from "./explicit-model-agent.js";

/** Public compatibility facade retaining the synchronous default-model constructor. */
export class Agent extends ExplicitModelAgent {
  constructor(opts: AgentOptions = {}) {
    const initialState: Partial<AgentState> & Pick<AgentState, "model"> = {
      ...opts.initialState,
      model:
        opts.initialState?.model ??
        getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
    };
    super({ ...opts, initialState });
  }
}
