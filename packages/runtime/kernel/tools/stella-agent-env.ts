import path from "path";

/**
 * Variables every device-side agent shell carries: the app's own checkout,
 * where drafts of changes to it live (see the modify-stella skill), and the
 * agent's id, which the checkout's git hook uses to note which agent made a
 * draft so the chat offers Update on that agent's completion. Shared by
 * Stella's shell tool and engines whose CLIs bring their own shell.
 */
export const stellaAgentShellEnvironment = (context: {
  stellaAppDir?: string;
  stellaDataDir?: string;
  agentId?: string;
}): Record<string, string> => {
  const env: Record<string, string> = {};
  if (context.stellaAppDir) {
    env.STELLA_APP_DIR = path.resolve(context.stellaAppDir);
  }
  if (context.stellaDataDir) {
    env.STELLA_DRAFTS_DIR = path.join(
      path.resolve(context.stellaDataDir),
      "drafts",
    );
  }
  if (context.agentId) env.STELLA_AGENT_ID = context.agentId;
  return env;
};
