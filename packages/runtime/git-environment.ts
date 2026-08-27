export const setupGitEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; gitLocation: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  return {
    env,
    gitLocation: env.STELLA_GIT_BIN?.trim() || "git",
  };
};
