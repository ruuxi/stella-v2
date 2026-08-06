/**
 * Resolve the Git executable shipped with packaged Stella. Development and
 * source runs fall back to Git on PATH.
 */
export const setupGitEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; gitLocation: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  return {
    env,
    gitLocation: env.STELLA_GIT_BIN?.trim() || "git",
  };
};
