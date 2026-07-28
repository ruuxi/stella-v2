/**
 * Project workspace preparation for `project:<slug>` turns.
 *
 * The workspace root is a checkpointed sandbox directory, so a project is
 * cloned exactly once and every later turn restores the tree and fetches on
 * top of it. The installation token that authenticates the fetch is minted
 * per turn and is deliberately short-lived: it is handed to git through an
 * askpass helper that reads it from the child process environment, so it
 * never reaches the repository config, the remote URL, the reflog, or any
 * file this module writes. Nothing here logs it.
 *
 * It also never reaches the turn input the agent can read. The DO writes it to
 * a one-shot file above the workspace root and names that file in the turn
 * input; `takeProjectCredentials` reads and unlinks it before the tool host
 * exists, so no shell the agent runs can ever open it, and nothing carries it
 * into a checkpoint.
 */

import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The token-free half of the project handoff: this travels in turn input. */
export type ProjectTurnInput = {
  remoteUrl: string;
  defaultBranch: string;
  branch: string;
  setupScript?: string;
  /**
   * Path to the one-shot `{ token }` file the DO wrote outside the
   * checkpointed root. The path is not a secret; what it points at is, and it
   * exists only until {@link takeProjectCredentials} runs.
   */
  credentialsPath?: string;
};

/**
 * Take the installation token off the filesystem, once. The file is unlinked
 * whether or not it parsed, and this runs before the tool host is built, so
 * the window in which it exists contains no agent-controlled code at all.
 */
export const takeProjectCredentials = async (
  project: ProjectTurnInput,
): Promise<string | undefined> => {
  const target = project.credentialsPath?.trim();
  if (!target) return undefined;
  const raw = await readFile(target, "utf8").catch(() => null);
  await rm(target, { force: true }).catch(() => undefined);
  if (!raw) return undefined;
  try {
    const token = (JSON.parse(raw) as { token?: unknown }).token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
};

export type ProjectWorkspaceResult = {
  mode: "cloned" | "restored";
  branch: string;
  /** The command the workspace was (or would be) set up with. */
  setupCommand?: string;
  setupSource?: "provided" | "inferred";
  setupRan: boolean;
  setupExitCode?: number;
  /** Human-readable, token-free notes folded into the agent's system prompt. */
  notes: string[];
};

// The setup marker has to survive to the next turn, so it lives inside the
// checkpointed root — but the root is the user's working tree and the agent is
// told to commit there, so it goes under `.git`, which git itself never
// tracks, stages or reports as dirty.
const SETUP_MARKER = ".git/stella-project-setup.json";
/** Where earlier turns wrote it: read for continuity, never written again. */
const LEGACY_SETUP_MARKER = ".stella/project-setup.json";
const GIT_EXCLUDE_ENTRY = "/.stella/";
const GIT_TIMEOUT_MS = 5 * 60_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;

type RunResult = { code: number; stdout: string; stderr: string };

const exists = async (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

/**
 * A remote URL is echoed back into prompts and reports. Even though this
 * module never builds a credentialed URL, a caller-supplied one would leak
 * through every one of those surfaces.
 */
export const scrubRemoteUrl = (remoteUrl: string): string => {
  try {
    const url = new URL(remoteUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remoteUrl.replace(/\/\/[^@/]+@/, "//");
  }
};

const run = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr: stderr.slice(-4_000) }),
    );
  });

/**
 * Base environment for every child this module spawns. The turn token and the
 * installation token are both withheld: git has its own credential path, and
 * a setup script has no business with either.
 */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.STELLA_TURN_TOKEN;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
};

/**
 * Credentials reach git through an askpass helper whose *contents* carry no
 * secret — it prints whatever the child's environment holds. The token
 * therefore exists only in the memory of the git process tree, never in the
 * script, the repo config, or the command line (which `ps` would expose to
 * the agent's own shells).
 */
const withGitCredentials = async <T>(
  token: string | undefined,
  body: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> => {
  const env = childEnv();
  if (!token) return body(env);
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-gitauth-"));
  const askpass = path.join(dir, "askpass.sh");
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  Username*) printf %s "$STELLA_GIT_USERNAME" ;;\n  *) printf %s "$STELLA_GIT_TOKEN" ;;\nesac\n',
    "utf8",
  );
  await chmod(askpass, 0o700);
  try {
    return await body({
      ...env,
      GIT_ASKPASS: askpass,
      STELLA_GIT_USERNAME: "x-access-token",
      STELLA_GIT_TOKEN: token,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// An empty `credential.helper` resets the helper list, so no helper can cache
// the installation token to disk. `-c` before the subcommand applies to this
// invocation only; `git clone -c` would persist it into the new repo's config.
const GIT_SAFE_ARGS = ["-c", "credential.helper="];

const gitFailure = (label: string, result: RunResult): Error =>
  new Error(
    `${label} failed (exit ${result.code}): ${result.stderr.trim().slice(-600) || "no output"}`,
  );

const LOCKFILE_COMMANDS: Array<[string, string]> = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  ["requirements.txt", "pip install -r requirements.txt"],
  ["Cargo.toml", "cargo fetch"],
  ["go.mod", "go mod download"],
];

const README_COMMAND = /^\s*(bun|npm|pnpm|yarn)\s+(install|ci)\b[^\n]*$/gm;

/**
 * Infer the one command that makes a freshly cloned repo runnable. Lockfiles
 * are authoritative; a README is consulted only when the repo has no lockfile
 * at all, and only for an install line it states verbatim.
 */
const inferSetupCommand = async (root: string): Promise<string | undefined> => {
  for (const [file, command] of LOCKFILE_COMMANDS) {
    if (await exists(path.join(root, file))) return command;
  }
  if (await exists(path.join(root, "package.json"))) return "npm install";
  const readme = await readFile(path.join(root, "README.md"), "utf8").catch(
    () => "",
  );
  const match = README_COMMAND.exec(readme.slice(0, 20_000));
  README_COMMAND.lastIndex = 0;
  return match ? match[0].trim() : undefined;
};

/**
 * Teach the clone to ignore `.stella/` locally. Nothing writes there any more,
 * but a workspace restored from before that change carries one, and a repo
 * whose `git add -A` sweeps it up would commit Stella's bookkeeping into the
 * user's branch. `.git/info/exclude` is per-clone and is never committed; it
 * has no effect on paths the repository already tracks.
 */
const excludeStellaState = async (root: string): Promise<void> => {
  const excludePath = path.join(root, ".git", "info", "exclude");
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === GIT_EXCLUDE_ENTRY)) {
    return;
  }
  await mkdir(path.dirname(excludePath), { recursive: true });
  const separator = !current || current.endsWith("\n") ? "" : "\n";
  await writeFile(
    excludePath,
    `${current}${separator}${GIT_EXCLUDE_ENTRY}\n`,
    "utf8",
  );
};

const commandIsRunnable = async (command: string): Promise<boolean> => {
  const binary = command.trim().split(/\s+/)[0] ?? "";
  if (!binary) return false;
  const result = await run("sh", ["-c", `command -v ${binary}`], {
    cwd: "/",
    env: childEnv(),
    timeoutMs: 10_000,
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return result.code === 0;
};

/**
 * Bring the project workspace to the turn's branch and, on a cold workspace,
 * install its dependencies. Returns what happened so the caller can describe
 * the workspace to the agent and persist the resolved setup command.
 */
export const prepareProjectWorkspace = async (
  root: string,
  project: ProjectTurnInput,
  emit: (message: string) => void,
  /** From {@link takeProjectCredentials}; never from `project` itself. */
  token: string | undefined,
): Promise<ProjectWorkspaceResult> => {
  const remoteUrl = scrubRemoteUrl(project.remoteUrl);
  const branch = project.branch.trim() || project.defaultBranch.trim();
  const defaultBranch = project.defaultBranch.trim() || "main";
  const notes: string[] = [];
  const cold = !(await exists(path.join(root, ".git")));

  await withGitCredentials(token, async (env) => {
    const git = (args: string[], cwd = root) =>
      run("git", [...GIT_SAFE_ARGS, ...args], {
        cwd,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
      });

    if (cold) {
      emit("Cloning the project repository.");
      const clone = await git(
        ["clone", "--branch", defaultBranch, remoteUrl, root],
        "/",
      );
      if (clone.code !== 0) throw gitFailure("git clone", clone);
      const checkout = await git(["checkout", "-B", branch]);
      if (checkout.code !== 0) throw gitFailure("git checkout", checkout);
      return;
    }

    emit("Fetching the project repository.");
    const fetched = await git(["fetch", "--prune", "origin"]);
    if (fetched.code !== 0) {
      // A restored workspace is still usable offline; the agent works on the
      // checkpointed tree and the report says the fetch did not land.
      notes.push(
        "The fetch from the remote failed; this workspace is at its last checkpointed state.",
      );
    }
    const current = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.stdout.trim() !== branch) {
      const checkout = await git(["checkout", branch]);
      if (checkout.code !== 0) {
        const created = await git([
          "checkout",
          "-B",
          branch,
          `origin/${defaultBranch}`,
        ]);
        if (created.code !== 0) throw gitFailure("git checkout", created);
      }
    }
  });

  await excludeStellaState(root).catch(() => undefined);

  // Setup happens once per workspace. Re-deriving it on a warm restore would
  // not just waste a minute — the command that ran may have rewritten the
  // lockfiles the inference reads, so it can come back different.
  const markerPath = path.join(root, SETUP_MARKER);
  type SetupMarker = {
    setupCommand?: string;
    setupSource?: "provided" | "inferred";
  };
  const readMarker = async (target: string): Promise<SetupMarker | null> =>
    readFile(target, "utf8").then(
      (raw) => JSON.parse(raw) as SetupMarker,
      () => null,
    );
  const recorded =
    (await readMarker(markerPath)) ??
    (await readMarker(path.join(root, LEGACY_SETUP_MARKER)));
  const provided = project.setupScript?.trim();
  const setupCommand =
    recorded?.setupCommand ?? (provided || (await inferSetupCommand(root)));
  const setupSource = recorded
    ? recorded.setupSource
    : provided
      ? "provided"
      : setupCommand
        ? "inferred"
        : undefined;

  let setupRan = false;
  let setupExitCode: number | undefined;
  if (setupCommand && !recorded) {
    if (await commandIsRunnable(setupCommand)) {
      emit(`Setting up the workspace: ${setupCommand}`);
      const setup = await run("bash", ["-lc", setupCommand], {
        cwd: root,
        env: childEnv(),
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      setupRan = true;
      setupExitCode = setup.code;
      if (setup.code !== 0) {
        notes.push(
          `Setup command "${setupCommand}" exited ${setup.code}: ${setup.stderr.trim().slice(-400)}`,
        );
      }
    } else {
      notes.push(
        `Setup command "${setupCommand}" was inferred but its runtime is not installed in this sandbox; dependencies are not installed.`,
      );
    }
    await mkdir(path.dirname(markerPath), { recursive: true })
      .then(() =>
        writeFile(
          markerPath,
          `${JSON.stringify({ setupCommand, setupSource, setupRan, setupExitCode, at: Date.now() }, null, 2)}\n`,
          "utf8",
        ),
      )
      .catch(() => undefined);
  }

  return {
    mode: cold ? "cloned" : "restored",
    branch,
    ...(setupCommand ? { setupCommand } : {}),
    ...(setupSource ? { setupSource } : {}),
    setupRan,
    ...(setupExitCode === undefined ? {} : { setupExitCode }),
    notes,
  };
};
