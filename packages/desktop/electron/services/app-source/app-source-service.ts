import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  BackendClient,
  BackendRequestError,
} from "@stella/contracts/backend/client";
import type { AppSourceRemote } from "@stella/contracts/backend/app-source";
import type {
  AppSourceActionResult,
  AppSourceDraft,
  AppSourceState,
} from "@stella/contracts/desktop/app-source";
import {
  DRAFT_REF_PREFIX,
  git,
  gitRaw,
  isAncestor,
  isDraftName,
  listWorktrees,
  run,
} from "./git.js";
import { DRAFT_AGENTS_DIR, installCheckoutGuard } from "./checkout-guard.js";
import type { CoveredWindow } from "./update-transition.js";

/**
 * Applies finished drafts to the app's own checkout, undoes recent commits,
 * keeps the checkout in step with the owner's fork on Artifacts, and takes
 * updates from the published app (upstream).
 *
 * Git is the only bookkeeping: drafts are `draft/<name>` branches (in
 * progress while a worktree has one checked out), "recent" is first-parent
 * history, and the fork and upstream are remote-tracking refs. Every git call
 * is async so main never blocks on one.
 */

type AppSourceServiceOptions = {
  stellaAppDir: string;
  broadcast: (state: AppSourceState) => void;
  isAnyWindowVisible: () => boolean;
  requestRuntimeRestart: () => void;
  applyRendererChanges: (paths: string[]) => Promise<unknown> | undefined;
  relaunch: () => void;
  hasConnectedAccount: () => boolean;
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  log: (event: string, data: Record<string, unknown>) => void;
  /** After a successful push to the fork. Not awaited by the push. */
  onPushed?: (cwd: string) => void | Promise<void>;
  /**
   * After an apply, undo, applyRemote or applyUpstream lands in the checkout,
   * before it is swapped in. A throw fails the action.
   */
  afterApply?: (cwd: string) => void | Promise<void>;
  /**
   * Runs before every action, against the checkout as it stands. A throw
   * refuses the action (the launcher refuses to act on an unsigned HEAD).
   */
  beforeAction?: (cwd: string) => void | Promise<void>;
  /**
   * Picture and cover the window before a renderer swap; the covered window
   * then runs the swap and reveals it. Null runs the swap plain.
   */
  coverRenderer?: () => Promise<CoveredWindow | null>;
  /** Before a relaunch: hold the window on screen. Never throws. */
  beforeRelaunch?: () => Promise<void>;
};

type ForkAccess = {
  remote: string;
  branch: string;
  token: string;
  expiresAt: number;
};

/** The fork exists only for a signed-in owner; upstream is always readable. */
type SourceAccess = { fork: ForkAccess | null; upstream: AppSourceRemote };

class ConflictError extends Error {}

const STATE_POLL_MS = 10_000;
const FORK_FIRST_SYNC_DELAY_MS = 20_000;
const FORK_SYNC_INTERVAL_MS = 30 * 60_000;
const RECENT_COUNT = 8;
const FORK_REF_PREFIX = "refs/remotes/stella-fork/";
const UPSTREAM_REF = "refs/remotes/stella-upstream/main";
/** Under the git common dir: the agent whose draft each applied commit was. */
const COMMIT_AGENTS_DIR = "stella-commits";
/** A change here takes a relaunch (main and preload build on launch). */
const RESTART_PREFIX = "packages/desktop/electron/";
/** Public: anonymous users read upstream with a shared, edge-cached token. */
const BOOTSTRAP_PATH = "/api/app-source/bootstrap";
const ACCESS_ATTEMPTS = 5;

const NO_UPSTREAM: AppSourceState["upstream"] = {
  status: "none",
  count: 0,
  subject: "",
};

const EMPTY_STATE: AppSourceState = {
  ready: [],
  stale: [],
  remote: { status: "none", count: 0 },
  upstream: NO_UPSTREAM,
  recent: [],
  busy: false,
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Git config through the environment keeps the token out of argv.
 *
 * Fetches use protocol v2. Artifacts' v1 upload-pack answers a stateless
 * negotiation round with a bare "ACK <oid>" instead of multi_ack_detailed's
 * "ACK <oid> common", so git takes it as the final ACK, and the NAK the server
 * then puts before the pack fails as "bad band #78" (N). That happens whenever
 * a common commit turns up in a round before git runs out of haves (rounds
 * are 16+ haves), so any checkout with real history hits it. Pushes stay on
 * v1.
 */
const remoteEnv = (
  token: string,
  protocolVersion: "1" | "2",
): NodeJS.ProcessEnv => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  GIT_CONFIG_KEY_1: "protocol.version",
  GIT_CONFIG_VALUE_1: protocolVersion,
});
const fetchEnv = (token: string) => remoteEnv(token, "2");
const pushEnv = (token: string) => remoteEnv(token, "1");

export class AppSourceService {
  private readonly options: AppSourceServiceOptions;
  private state: AppSourceState = EMPTY_STATE;
  private published = JSON.stringify(EMPTY_STATE);
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private syncing = false;
  private timers: NodeJS.Timeout[] = [];
  private backend: { baseUrl: string; client: BackendClient } | null = null;
  private access: SourceAccess | null = null;
  /** The fork's branch, once fetched and found to share history with HEAD. */
  private forkBranch: string | null = null;
  private forkUnrelated = false;
  /** Upstream was fetched and shares history with HEAD. */
  private upstreamTracked = false;
  private upstreamUnrelated = false;
  private disposed = false;
  private readonly onFocus = () => void this.refresh();

  constructor(options: AppSourceServiceOptions) {
    this.options = options;
  }

  start() {
    if (this.disposed || this.timers.length > 0) return;
    app.on("browser-window-focus", this.onFocus);
    const poll = setInterval(() => {
      if (this.options.isAnyWindowVisible()) void this.refresh();
    }, STATE_POLL_MS);
    const firstSync = setTimeout(
      () => void this.syncFork(),
      FORK_FIRST_SYNC_DELAY_MS,
    );
    const sync = setInterval(() => void this.syncFork(), FORK_SYNC_INTERVAL_MS);
    for (const timer of [poll, firstSync, sync]) timer.unref?.();
    this.timers = [poll, firstSync, sync];
    void installCheckoutGuard(this.options.stellaAppDir, this.options.log).catch(
      (error: unknown) =>
        this.options.log("app-source.checkout-guard-failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    void this.refresh();
  }

  dispose() {
    this.disposed = true;
    app.removeListener("browser-window-focus", this.onFocus);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.backend?.client.dispose();
  }

  getState(): AppSourceState {
    void this.refresh();
    return this.state;
  }

  applyDraft(name: string) {
    return this.exclusive(async (cwd) => {
      if (!isDraftName(name)) throw new Error("Unknown draft.");
      const ref = `${DRAFT_REF_PREFIX}${name}`;
      if ((await listWorktrees(cwd)).some((tree) => tree.branch === ref)) {
        throw new Error(`The draft "${name}" is still being worked on.`);
      }
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const tip = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!(await isAncestor(cwd, head, tip))) {
        throw new Error(
          "This draft is no longer based on the current version.",
        );
      }
      await git(cwd, ["merge", "--ff-only", tip]);
      await git(cwd, ["branch", "-D", `draft/${name}`]);
      await this.rememberAgent(cwd, name, tip);
      await this.swapIn(cwd, head, tip);
    });
  }

  /** Carry a draft's agent over to the commit that applied it. */
  private async rememberAgent(cwd: string, name: string, sha: string) {
    const from = path.join(await this.commonDir(cwd), DRAFT_AGENTS_DIR, name);
    const agentId = await this.agentOf(cwd, DRAFT_AGENTS_DIR, name);
    if (!agentId) return;
    await this.writeChange(cwd, sha, agentId, false);
    await fs.rm(from, { force: true });
  }

  /** Note a commit as applying (or undoing) an agent's change. */
  private async writeChange(cwd: string, sha: string, agentId: string, undone: boolean) {
    const dir = path.join(await this.commonDir(cwd), COMMIT_AGENTS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, sha), `${agentId}\n${undone ? "undone\n" : ""}`);
  }

  /** The agent change a commit applied or undid, if it was one. */
  private async changeOf(cwd: string, sha: string) {
    const file = path.join(await this.commonDir(cwd), COMMIT_AGENTS_DIR, sha);
    const [agentId = "", flag = ""] = (await fs.readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .map((line) => line.trim());
    return agentId ? { agentId, undone: flag === "undone" } : null;
  }

  private commonDirPath: string | null = null;
  private async commonDir(cwd: string) {
    this.commonDirPath ??= await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return this.commonDirPath;
  }

  /** The agent noted in `dir` under `key`, if any. */
  private async agentOf(cwd: string, dir: string, key: string) {
    const file = path.join(await this.commonDir(cwd), dir, key);
    const agentId = (await fs.readFile(file, "utf8").catch(() => "")).trim();
    return agentId || undefined;
  }

  /** What a draft changes against `head`: file count, and whether it relaunches. */
  private async draftShape(cwd: string, head: string, sha: string) {
    const paths = (await git(cwd, ["diff", "--name-only", `${head}...${sha}`]))
      .split("\n")
      .filter(Boolean);
    return {
      files: paths.length,
      restart: paths.some((file) => file.startsWith(RESTART_PREFIX)),
    };
  }

  undo(sha: string) {
    return this.exclusive(async (cwd) => {
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
        throw new Error("Unknown change.");
      }
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      if (!(await isAncestor(cwd, sha, head))) {
        throw new Error("That change is not part of the current version.");
      }
      const subject = await git(cwd, ["log", "-1", "--format=%s", sha]);
      // Three-way merge with the change as base and its parent as "theirs":
      // HEAD minus the change, computed without touching the working tree.
      const merge = await gitRaw(cwd, [
        "merge-tree",
        "--write-tree",
        "--merge-base",
        sha,
        head,
        `${sha}^`,
      ]);
      if (merge.code === 1) {
        throw new ConflictError("Later changes conflict with this undo.");
      }
      if (merge.code !== 0) {
        throw new Error(merge.stderr.trim() || "Could not compute the undo.");
      }
      const tree = merge.stdout.split("\n")[0]!.trim();
      const revert = await git(
        cwd,
        ["commit-tree", tree, "-p", head, "-m", `Revert "${subject}"`],
        { env: await this.identityEnv(cwd) },
      );
      await git(cwd, ["merge", "--ff-only", revert]);
      // Undoing an agent's change (or an undo of it) stays that agent's.
      const change = await this.changeOf(cwd, sha);
      if (change) await this.writeChange(cwd, revert, change.agentId, !change.undone);
      await this.swapIn(cwd, head, revert);
    });
  }

  /** Take the fork's changes ("from your other computer"). */
  applyRemote() {
    return this.exclusive(async (cwd) => {
      if (!this.forkBranch)
        throw new Error("No changes from your other computers.");
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const tip = await git(cwd, [
        "rev-parse",
        "--verify",
        `${FORK_REF_PREFIX}${this.forkBranch}^{commit}`,
      ]);
      if (!(await isAncestor(cwd, head, tip))) {
        throw new Error("These changes have diverged from this computer's.");
      }
      await git(cwd, ["merge", "--ff-only", tip]);
      await this.swapIn(cwd, head, tip);
    });
  }

  /**
   * Take the published app's update when this checkout has no changes of its
   * own. With changes, an agent merges upstream in a draft instead.
   */
  applyUpstream() {
    return this.exclusive(async (cwd) => {
      if (!this.upstreamTracked) throw new Error("No update is available.");
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const tip = await git(cwd, [
        "rev-parse",
        "--verify",
        `${UPSTREAM_REF}^{commit}`,
      ]);
      if (!(await isAncestor(cwd, head, tip))) {
        throw new Error("This update has to be merged with your changes.");
      }
      await git(cwd, ["merge", "--ff-only", tip]);
      await this.swapIn(cwd, head, tip);
    });
  }

  private exclusive(
    task: (cwd: string) => Promise<void>,
  ): Promise<AppSourceActionResult> {
    const result = this.queue.then(async (): Promise<AppSourceActionResult> => {
      this.setBusy(true);
      try {
        await this.options.beforeAction?.(this.options.stellaAppDir);
        await task(this.options.stellaAppDir);
        this.pushToFork();
        return { ok: true };
      } catch (error) {
        this.options.log("app-source.action-failed", {
          message: errorMessage(error),
        });
        return {
          ok: false,
          error: errorMessage(error),
          ...(error instanceof ConflictError ? { conflict: true } : {}),
        };
      } finally {
        this.setBusy(false);
        void this.refresh();
      }
    });
    this.queue = result;
    return result;
  }

  /** Make a change that just landed in the checkout take effect. */
  private async swapIn(cwd: string, from: string, to: string) {
    const paths = (await git(cwd, ["diff", "--name-only", from, to]))
      .split("\n")
      .filter(Boolean);
    const touches = (prefix: string) =>
      paths.some((file) => file.startsWith(prefix));
    const install = paths.some(
      (file) => file === "bun.lock" || file.endsWith("package.json"),
    );
    const restart = touches(RESTART_PREFIX);
    // Only changes the renderer can show get the transition: the runtime and
    // the desktop shell aren't in the window.
    const visible =
      !restart &&
      paths.some(
        (file) =>
          !file.startsWith("packages/runtime/") &&
          !file.startsWith("packages/desktop/"),
      );
    // Picture the window while the launcher signs the change (nothing on
    // screen moves meanwhile). Not across a dependency install: that can take
    // minutes, and the window stays live for it.
    let covering =
      visible && !install ? this.options.coverRenderer?.() ?? null : null;
    try {
      await this.options.afterApply?.(cwd);
    } catch (error) {
      await (await covering)?.cancel();
      throw error;
    }
    this.options.log("app-source.applied", { files: paths.length });
    if (install) {
      const bun = process.env.STELLA_BUN_PATH?.trim() || "bun";
      const result = await run(bun, ["install"], {
        cwd,
        timeoutMs: 10 * 60_000,
      });
      if (result.code !== 0) {
        throw new Error(
          `The change is applied, but bun install failed: ${result.stderr.trim().slice(-400)}`,
        );
      }
    }
    if (touches("packages/runtime/") || touches("packages/contracts/")) {
      this.options.requestRuntimeRestart();
    }
    if (restart) {
      // Main and preload are rebuilt from source on launch.
      await this.options.beforeRelaunch?.();
      this.options.relaunch();
      return;
    }
    if (visible && install) covering = this.options.coverRenderer?.() ?? null;
    const covered = await covering;
    const swap = async () => {
      await this.options.applyRendererChanges(paths);
    };
    await (covered ? covered.reveal(swap) : swap());
  }

  private async identityEnv(
    cwd: string,
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if ((await gitRaw(cwd, ["var", "GIT_COMMITTER_IDENT"])).code === 0) {
      return undefined;
    }
    return {
      GIT_AUTHOR_NAME: "Stella",
      GIT_AUTHOR_EMAIL: "stella@localhost",
      GIT_COMMITTER_NAME: "Stella",
      GIT_COMMITTER_EMAIL: "stella@localhost",
    };
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.publish({ ...this.state, busy });
  }

  private publish(next: AppSourceState) {
    this.state = next;
    const json = JSON.stringify(next);
    if (json === this.published) return;
    this.published = json;
    this.options.broadcast(next);
  }

  refresh(): Promise<void> {
    // Mid-action the checkout is in flux (a draft's branch is already gone
    // while its change is still swapping in); the action refreshes when it
    // ends, so the chat never sees a half-applied state.
    if (this.disposed || this.busy) return Promise.resolve();
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          this.publish({ ...(await this.readState()), busy: this.busy });
        } catch (error) {
          this.options.log("app-source.refresh-failed", {
            message: errorMessage(error),
          });
        }
      } while (this.refreshAgain && !this.disposed);
    })().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = refreshing;
    return refreshing;
  }

  private async readState(): Promise<Omit<AppSourceState, "busy">> {
    const cwd = this.options.stellaAppDir;
    const [head, worktrees, refs, log] = await Promise.all([
      git(cwd, ["rev-parse", "HEAD"]),
      listWorktrees(cwd),
      git(cwd, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(subject)",
        DRAFT_REF_PREFIX,
      ]),
      git(cwd, [
        "log",
        "--first-parent",
        `-n${RECENT_COUNT}`,
        "--format=%H%x00%s%x00%ct",
        "HEAD",
      ]),
    ]);
    const inProgress = new Set(worktrees.map((tree) => tree.branch));
    const ready: AppSourceDraft[] = [];
    const stale: AppSourceDraft[] = [];
    for (const line of refs.split("\n").filter(Boolean)) {
      const [refname = "", sha = "", subject = ""] = line.split("\0");
      const name = refname.slice(DRAFT_REF_PREFIX.length);
      if (!isDraftName(name) || inProgress.has(refname) || sha === head)
        continue;
      const list = (await isAncestor(cwd, head, sha))
        ? ready
        : (await isAncestor(cwd, sha, head))
          ? null
          : stale;
      if (!list) continue;
      const agentId = await this.agentOf(cwd, DRAFT_AGENTS_DIR, name);
      list.push({
        name,
        subject,
        sha,
        ...(agentId ? { agentId } : {}),
        ...(await this.draftShape(cwd, head, sha)),
      });
    }
    const recent = await Promise.all(
      log
        .split("\n")
        .filter(Boolean)
        .map(async (line) => {
          const [sha = "", subject = "", seconds = "0"] = line.split("\0");
          const change = await this.changeOf(cwd, sha);
          return {
            sha,
            subject,
            date: Number(seconds) * 1000,
            ...(change
              ? { agentId: change.agentId, ...(change.undone ? { undone: true } : {}) }
              : {}),
          };
        }),
    );
    const [remote, upstream] = await Promise.all([
      this.forkBranch
        ? this.compareRef(cwd, head, `${FORK_REF_PREFIX}${this.forkBranch}`)
        : null,
      this.upstreamTracked ? this.compareRef(cwd, head, UPSTREAM_REF) : null,
    ]);
    return {
      ready,
      stale,
      remote: remote
        ? { status: remote.status, count: remote.count }
        : { status: "none", count: 0 },
      upstream: upstream ?? NO_UPSTREAM,
      recent,
    };
  }

  /** A remote-tracking ref that has commits HEAD lacks, or null. */
  private async compareRef(cwd: string, head: string, ref: string) {
    const tip = (
      await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    ).stdout.trim();
    if (!tip || tip === head || (await isAncestor(cwd, tip, head))) return null;
    const [count, subject, ahead] = await Promise.all([
      git(cwd, ["rev-list", "--count", `${head}..${tip}`]),
      git(cwd, ["log", "-1", "--format=%s", tip]),
      isAncestor(cwd, head, tip),
    ]);
    return {
      status: ahead ? ("ahead" as const) : ("diverged" as const),
      count: Number(count),
      subject,
    };
  }

  /** Fetch the fork and upstream; push to the fork when this computer is ahead. */
  async syncFork() {
    if (this.disposed || this.busy || this.syncing) return;
    this.syncing = true;
    const cwd = this.options.stellaAppDir;
    try {
      // A draft in progress: its base must not move under the agent.
      const worktrees = await listWorktrees(cwd);
      if (worktrees.some((tree) => tree.branch?.startsWith(DRAFT_REF_PREFIX))) {
        return;
      }
      const access = await this.sourceAccess();
      if (!access) return;
      if (access.fork && !this.forkUnrelated) {
        await this.syncWithFork(cwd, access.fork).catch((error) => {
          this.options.log("app-source.fork-sync-failed", {
            message: errorMessage(error),
          });
        });
      }
      // A checkout unrelated to the fork is unrelated to upstream too.
      if (!this.forkUnrelated && !this.upstreamUnrelated) {
        await this.fetchUpstream(cwd, access.upstream);
      }
    } catch (error) {
      this.options.log("app-source.sync-failed", {
        message: errorMessage(error),
      });
    } finally {
      this.syncing = false;
      void this.refresh();
    }
  }

  private async syncWithFork(cwd: string, fork: ForkAccess) {
    const ref = `${FORK_REF_PREFIX}${fork.branch}`;
    await git(
      cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        fork.remote,
        `+refs/heads/${fork.branch}:${ref}`,
      ],
      { env: fetchEnv(fork.token), timeoutMs: 5 * 60_000 },
    );
    // The dev repo's history is unrelated to the published fork; only
    // checkouts cloned from the fork sync with it.
    if ((await gitRaw(cwd, ["merge-base", "HEAD", ref])).code !== 0) {
      this.forkUnrelated = true;
      this.options.log("app-source.fork-unrelated", {});
      return;
    }
    this.forkBranch = fork.branch;
    await this.pushIfAhead(cwd, fork);
  }

  private async fetchUpstream(cwd: string, upstream: AppSourceRemote) {
    await git(
      cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        upstream.remote,
        `+refs/heads/main:${UPSTREAM_REF}`,
      ],
      { env: fetchEnv(upstream.token), timeoutMs: 5 * 60_000 },
    );
    if ((await gitRaw(cwd, ["merge-base", "HEAD", UPSTREAM_REF])).code !== 0) {
      this.upstreamUnrelated = true;
      this.upstreamTracked = false;
      this.options.log("app-source.upstream-unrelated", {});
      return;
    }
    this.upstreamTracked = true;
  }

  /** Best-effort, never awaited by an action. */
  private pushToFork() {
    if (!this.forkBranch) return;
    void (async () => {
      const fork = (await this.sourceAccess())?.fork;
      if (fork) await this.pushIfAhead(this.options.stellaAppDir, fork);
    })()
      .catch((error) => {
        this.options.log("app-source.fork-push-failed", {
          message: errorMessage(error),
        });
      })
      .finally(() => void this.refresh());
  }

  private async pushIfAhead(cwd: string, fork: ForkAccess) {
    const ref = `${FORK_REF_PREFIX}${fork.branch}`;
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const forkTip = await git(cwd, ["rev-parse", "--verify", ref]);
    // Only fast-forwards: a diverged fork is merged by an agent, never forced.
    if (forkTip === head || !(await isAncestor(cwd, forkTip, head))) return;
    await git(
      cwd,
      ["push", "--quiet", fork.remote, `HEAD:refs/heads/${fork.branch}`],
      { env: pushEnv(fork.token), timeoutMs: 5 * 60_000 },
    );
    await git(cwd, ["update-ref", ref, head]);
    const onPushed = this.options.onPushed;
    if (onPushed) {
      void Promise.resolve()
        .then(() => onPushed(cwd))
        .catch((error) => {
          this.options.log("app-source.on-pushed-failed", {
            message: errorMessage(error),
          });
        });
    }
  }

  /**
   * A signed-in owner gets their fork (write) and upstream (read) from
   * `appSource.access`; anyone else reads upstream through the public
   * bootstrap endpoint.
   */
  private async sourceAccess(): Promise<SourceAccess | null> {
    const baseUrl = this.options.getBackendUrl();
    if (!baseUrl) return null;
    const signedIn = this.options.hasConnectedAccount();
    const cached = this.access;
    if (
      cached &&
      (cached.fork !== null) === signedIn &&
      Math.min(cached.upstream.expiresAt, cached.fork?.expiresAt ?? Infinity) -
        60_000 >
        Date.now()
    ) {
      return cached;
    }
    this.access = signedIn
      ? await this.accountAccess(baseUrl)
      : { fork: null, upstream: await this.bootstrapAccess(baseUrl) };
    return this.access;
  }

  private async bootstrapAccess(baseUrl: string): Promise<AppSourceRemote> {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}${BOOTSTRAP_PATH}`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      throw new Error(`Update check failed (${response.status}).`);
    }
    const body = (await response.json()) as { upstream?: AppSourceRemote };
    const upstream = body.upstream;
    if (
      typeof upstream?.remote !== "string" ||
      typeof upstream.token !== "string" ||
      typeof upstream.expiresAt !== "number"
    ) {
      throw new Error("Update check returned an unexpected response.");
    }
    return upstream;
  }

  private async accountAccess(baseUrl: string): Promise<SourceAccess> {
    if (this.backend?.baseUrl !== baseUrl) {
      this.backend?.client.dispose();
      this.backend = {
        baseUrl,
        client: new BackendClient({
          baseUrl,
          getToken: () => this.options.getAuthToken(),
        }),
      };
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { fork, upstream } = await this.backend.client.call(
          "appSource.access",
          {},
        );
        return {
          fork: {
            remote: fork.remote,
            branch: fork.defaultBranch,
            token: fork.token,
            expiresAt: fork.expiresAt,
          },
          upstream,
        };
      } catch (error) {
        // The fork is created on first use; the backend asks to retry.
        if (
          attempt < ACCESS_ATTEMPTS &&
          error instanceof BackendRequestError &&
          error.code === "UNAVAILABLE" &&
          error.retryable &&
          !this.disposed
        ) {
          await delay(error.retryAfterMs ?? 2_000);
          continue;
        }
        throw error;
      }
    }
  }
}
