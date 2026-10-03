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

/** Git config through the environment keeps the token out of argv. */
const forkAuthEnv = (token: string): NodeJS.ProcessEnv => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  // Artifacts accepts pushes over protocol v1 only.
  GIT_CONFIG_KEY_1: "protocol.version",
  GIT_CONFIG_VALUE_1: "1",
});

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
      await this.swapIn(cwd, head, tip);
    });
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
    await this.options.afterApply?.(cwd);
    const paths = (await git(cwd, ["diff", "--name-only", from, to]))
      .split("\n")
      .filter(Boolean);
    this.options.log("app-source.applied", { files: paths.length });
    if (
      paths.some((file) => file === "bun.lock" || file.endsWith("package.json"))
    ) {
      const bun = process.env.STELLA_BUN_PATH?.trim() || "bun";
      const install = await run(bun, ["install"], {
        cwd,
        timeoutMs: 10 * 60_000,
      });
      if (install.code !== 0) {
        throw new Error(
          `The change is applied, but bun install failed: ${install.stderr.trim().slice(-400)}`,
        );
      }
    }
    const touches = (prefix: string) =>
      paths.some((file) => file.startsWith(prefix));
    if (touches("packages/runtime/") || touches("packages/contracts/")) {
      this.options.requestRuntimeRestart();
    }
    if (touches("packages/desktop/electron/")) {
      // Main and preload are rebuilt from source on launch.
      this.options.relaunch();
      return;
    }
    await this.options.applyRendererChanges(paths);
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
    if (this.disposed) return Promise.resolve();
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
      if (await isAncestor(cwd, head, sha)) {
        ready.push({ name, subject, sha });
      } else if (!(await isAncestor(cwd, sha, head))) {
        stale.push({ name, subject, sha });
      }
    }
    const recent = log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", subject = "", seconds = "0"] = line.split("\0");
        return { sha, subject, date: Number(seconds) * 1000 };
      });
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
      { env: forkAuthEnv(fork.token), timeoutMs: 5 * 60_000 },
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
      { env: forkAuthEnv(upstream.token), timeoutMs: 5 * 60_000 },
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
      { env: forkAuthEnv(fork.token), timeoutMs: 5 * 60_000 },
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
