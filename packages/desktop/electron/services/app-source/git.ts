import { execFile } from "node:child_process";

export type GitResult = { code: number; stdout: string; stderr: string };

const gitBinary = () => process.env.STELLA_GIT_BIN?.trim() || "git";

/** Run a command without a shell; resolves with its exit code, never throws on one. */
export const run = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error == null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : null;
        if (code === null) {
          reject(error);
          return;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const gitRaw = (
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) =>
  run(gitBinary(), args, {
    cwd,
    // Never prompt: a missing credential must fail, not hang main.
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
    timeoutMs: options.timeoutMs,
  });

/** Run git and return trimmed stdout; throws with git's message on failure. */
export const git = async (
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) => {
  const result = await gitRaw(cwd, args, options);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`,
    );
  }
  return result.stdout.trim();
};

/** `git merge-base --is-ancestor`: exit 0 yes, 1 no. */
export const isAncestor = async (
  cwd: string,
  ancestor: string,
  descendant: string,
) =>
  (await gitRaw(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]))
    .code === 0;

export type Worktree = { path: string; head: string; branch: string | null };

export const listWorktrees = async (cwd: string): Promise<Worktree[]> => {
  const output = await git(cwd, ["worktree", "list", "--porcelain"]);
  return output
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const space = line.indexOf(" ");
        fields.set(
          space < 0 ? line : line.slice(0, space),
          space < 0 ? "" : line.slice(space + 1),
        );
      }
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD") ?? "",
        branch: fields.get("branch") ?? null,
      };
    })
    .filter((worktree) => worktree.path);
};

export const DRAFT_REF_PREFIX = "refs/heads/draft/";

/** Draft names are one path segment: they name a branch and a directory. */
export const isDraftName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith(".lock");
