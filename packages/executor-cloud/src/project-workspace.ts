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
  chown,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import {
  assertWorkspaceDirectoryNoFollow,
  readWorkspaceFileNoFollow,
  statWorkspaceFileNoFollow,
  writeWorkspaceFileNoFollow,
} from "@stella/runtime/kernel/tools/workspace-file-boundary.js";

/** The token-free half of the project handoff: this travels in turn input. */
export type ProjectTurnInput = {
  remoteUrl: string;
  defaultBranch: string;
  branch: string;
  setupScript?: string;
  /**
   * Commit identity: the GitHub user who connected the installation, as their
   * noreply address. Absent (older connects) means commits fall back to the
   * container's default identity.
   */
  authorName?: string;
  authorEmail?: string;
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
  /**
   * Env that authenticates git for this repository (see
   * {@link createGitCredentialEnv}). The caller merges it into the agent's
   * shell environment so the agent can fetch, pull, and push — the whole
   * point of a connected project.
   */
  gitEnv?: GitCredentialEnv;
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

const safeFileExists = async (
  target: string,
  root: string,
  identity: ToolProcessIdentity,
): Promise<boolean> =>
  statWorkspaceFileNoFollow(target, root, { owner: identity }).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
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
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    identity: ToolProcessIdentity;
  },
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const launch = isolateToolProcessLaunch({
      command,
      commandArgs: args,
      identity: options.identity,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.nativeIdentity
        ? {
            uid: launch.nativeIdentity.uid,
            gid: launch.nativeIdentity.gid,
          }
        : {}),
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
const childEnv = (identity: ToolProcessIdentity): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.STELLA_TURN_TOKEN;
  delete env.STELLA_CODEX_TURN_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  return {
    ...env,
    HOME: identity.home,
    USER: identity.user,
    LOGNAME: identity.user,
    XDG_CONFIG_HOME: path.join(identity.home, ".config"),
    XDG_CACHE_HOME: path.join(identity.home, ".cache"),
    XDG_STATE_HOME: path.join(identity.home, ".local", "state"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
};

/**
 * The env additions that make git authenticate: an askpass helper carrying
 * the installation token in its own body (mode 0700, under the container's
 * tmpdir — outside the checkpointed root, so it never reaches a durable
 * backup and dies with the per-turn container).
 *
 * The token lives in the script rather than an env var on purpose: these
 * variables are ALSO handed to the agent's shells so the agent can push
 * (that's the feature), and a script keeps the token out of `env` output,
 * `/proc/<pid>/environ`, and accidental env dumps in logs or reports. The
 * agent can still read the script — same-user, same trust domain — but the
 * credential no longer travels anywhere by default. It is repo-scoped and
 * expires in about an hour either way.
 */
export type GitCredentialEnv = Record<string, string>;

const createGitCredentialEnv = async (
  token: string,
  identity: ToolProcessIdentity,
): Promise<GitCredentialEnv> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-gitauth-"));
  const askpass = path.join(dir, "askpass.sh");
  const quoted = token.replace(/'/g, "'\\''");
  await writeFile(
    askpass,
    `#!/bin/sh\ncase "$1" in\n  Username*) printf %s "x-access-token" ;;\n  *) printf %s '${quoted}' ;;\nesac\n`,
    "utf8",
  );
  await chmod(askpass, 0o700);
  await chown(askpass, identity.uid, identity.gid);
  await chown(dir, identity.uid, identity.gid);
  return { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
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
const inferSetupCommand = async (
  root: string,
  identity: ToolProcessIdentity,
): Promise<string | undefined> => {
  for (const [file, command] of LOCKFILE_COMMANDS) {
    if (await safeFileExists(path.join(root, file), root, identity)) {
      return command;
    }
  }
  if (await safeFileExists(path.join(root, "package.json"), root, identity)) {
    return "npm install";
  }
  const readme = await readWorkspaceFileNoFollow(
    path.join(root, "README.md"),
    root,
    20_000,
    { owner: identity },
  ).then(
    (read) => read.bytes.toString("utf8"),
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    },
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
const excludeStellaState = async (
  root: string,
  identity: ToolProcessIdentity,
): Promise<void> => {
  const excludePath = path.join(root, ".git", "info", "exclude");
  const current = await readWorkspaceFileNoFollow(
    excludePath,
    root,
    1024 * 1024,
    { owner: identity },
  ).then(
    (read) => read.bytes.toString("utf8"),
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    },
  );
  if (current.split("\n").some((line) => line.trim() === GIT_EXCLUDE_ENTRY)) {
    return;
  }
  const separator = !current || current.endsWith("\n") ? "" : "\n";
  await writeWorkspaceFileNoFollow(
    excludePath,
    root,
    `${current}${separator}${GIT_EXCLUDE_ENTRY}\n`,
    { owner: identity },
  );
};

const commandIsRunnable = async (
  command: string,
  identity: ToolProcessIdentity,
): Promise<boolean> => {
  const binary = command.trim().split(/\s+/)[0] ?? "";
  if (!binary) return false;
  const result = await run("sh", ["-c", `command -v ${binary}`], {
    cwd: "/",
    env: childEnv(identity),
    timeoutMs: 10_000,
    identity,
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
  identity: ToolProcessIdentity,
): Promise<ProjectWorkspaceResult> => {
  const remoteUrl = scrubRemoteUrl(project.remoteUrl);
  const branch = project.branch.trim() || project.defaultBranch.trim();
  const defaultBranch = project.defaultBranch.trim() || "main";
  const notes: string[] = [];
  const cold = !(await assertWorkspaceDirectoryNoFollow(
    path.join(root, ".git"),
    root,
    { owner: identity },
  ).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  ));

  const gitEnv = token
    ? await createGitCredentialEnv(token, identity)
    : undefined;
  {
    const env = { ...childEnv(identity), ...gitEnv };
    const git = (args: string[], cwd = root) =>
      run("git", [...GIT_SAFE_ARGS, ...args], {
        cwd,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
        identity,
      });

    const syncToBranch = async () => {
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
    };
    await syncToBranch();

    // Commit identity, written to the clone's local config so the agent's own
    // `git commit` picks it up. Re-run every turn: a checkpoint restored from
    // before this existed has no identity, and a reconnect can change it.
    if (project.authorName && project.authorEmail) {
      await git(["config", "user.name", project.authorName]);
      await git(["config", "user.email", project.authorEmail]);
    }
  }

  await excludeStellaState(root, identity).catch(() => undefined);

  // Setup happens once per workspace. Re-deriving it on a warm restore would
  // not just waste a minute — the command that ran may have rewritten the
  // lockfiles the inference reads, so it can come back different.
  const markerPath = path.join(root, SETUP_MARKER);
  type SetupMarker = {
    setupCommand?: string;
    setupSource?: "provided" | "inferred";
  };
  const readMarker = async (target: string): Promise<SetupMarker | null> =>
    readWorkspaceFileNoFollow(target, root, 64 * 1024, {
      owner: identity,
    }).then(
      (read) => JSON.parse(read.bytes.toString("utf8")) as SetupMarker,
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      },
    );
  const recorded =
    (await readMarker(markerPath)) ??
    (await readMarker(path.join(root, LEGACY_SETUP_MARKER)));
  const provided = project.setupScript?.trim();
  const setupCommand =
    recorded?.setupCommand ??
    (provided || (await inferSetupCommand(root, identity)));
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
    if (await commandIsRunnable(setupCommand, identity)) {
      emit(`Setting up the workspace: ${setupCommand}`);
      const setup = await run("bash", ["-lc", setupCommand], {
        cwd: root,
        env: childEnv(identity),
        timeoutMs: SETUP_TIMEOUT_MS,
        identity,
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
    await writeWorkspaceFileNoFollow(
      markerPath,
      root,
      `${JSON.stringify({ setupCommand, setupSource, setupRan, setupExitCode, at: Date.now() }, null, 2)}\n`,
      { owner: identity },
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
    ...(gitEnv ? { gitEnv } : {}),
  };
};
