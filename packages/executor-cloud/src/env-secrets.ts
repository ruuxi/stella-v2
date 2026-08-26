/**
 * Credentials the sandbox hands to the executor through its environment.
 *
 * The agent's tools run inside this process — every shell `exec_command`
 * starts inherits `process.env` — so a credential left in the environment is a
 * credential the agent can print. Each one is read exactly once, here, at
 * import time: before the tool host exists, before the agent loop starts, and
 * before any turn input is parsed, with the variable removed in the same step.
 *
 * The environment is not a containing channel on its own: `unsetenv` does not
 * scrub `/proc/<pid>/environ`, so a variable the sandbox sets stays readable
 * for the life of the process. That is why the GitHub installation token does
 * NOT come this way — it arrives in a one-shot file the executor unlinks (see
 * `takeProjectCredentials` in project-workspace.ts).
 */

const take = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  delete process.env[name];
  return value || undefined;
};

/** Per-turn credential for the Convex callbacks and the model relay. */
export const turnToken = take("STELLA_TURN_TOKEN");
