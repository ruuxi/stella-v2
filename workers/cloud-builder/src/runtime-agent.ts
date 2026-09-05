/** Loaded on first use so a turn never pays for the runtime agent it does not run. */
export const loadRuntimeAgent = async () =>
  (await import("@stella/runtime/kernel/agent-core/explicit-model-agent.js"))
    .ExplicitModelAgent;
