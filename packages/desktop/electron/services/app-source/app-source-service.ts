import { promises as fs } from "node:fs";
import { hostname } from "node:os";
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
  AppSourceElsewhere,
  AppSourceState,
} from "@stella/contracts/desktop/app-source";
import { isUpdateDraft } from "@stella/contracts/desktop/app-source";
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
import { classifyUpdate, type UpdatePlan } from "./update-plan.js";
import { checkMergedUpdate } from "./update-gate.js";
import { updateBrief, updateDraftName, type UpdateBrief } from "./update-brief.js";

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
  /** Scratch worktree for checking a merged update. Removed after each check. */
  updateScratchDir: string;
  /**
   * Hand an update that needs a judgement to a background agent. Absent when
   * no runtime is up, which leaves such an update unavailable rather than
   * applied unchecked.
   */
  dispatchUpdateMerge?: (brief: UpdateBrief) => Promise<void>;
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
/** How long "Stella is up to date" stays in the chat after an update lands. */
const UPDATE_DONE_MS = 20_000;
/** A merge that never arrives stops being announced after this. */
const UPDATE_MERGE_WAIT_MS = 60 * 60_000;
const FORK_FIRST_SYNC_DELAY_MS = 20_000;
const FORK_SYNC_INTERVAL_MS = 30 * 60_000;
const RECENT_COUNT = 8;
const FORK_REF_PREFIX = "refs/remotes/stella-fork/";
const UPSTREAM_REF = "refs/remotes/stella-upstream/main";
/** Under the git common dir: the agent whose draft each applied commit was. */
const COMMIT_AGENTS_DIR = "stella-commits";
/**
 * An agent's change applied here is tagged `stella-change/<hex agent id>`,
 * annotated with this computer's name, and pushed to the fork with main, so
 * the owner's other computers can offer it on that agent's completion.
 */
const CHANGE_TAG = "stella-change/";
const CHANGE_TAG_PREFIX = `refs/tags/${CHANGE_TAG}`;
/** Every computer's change tags, as last fetched from the fork. */
const FORK_CHANGES_PREFIX = "refs/stella/fork-changes/";
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
  elsewhere: [],
  busy: false,
};

/** This computer, as the owner's other computers name it. */
const deviceName = () =>
  hostname()
    .trim()
    .replace(/\.(local|localdomain|lan|home)$/i, "");

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
  /**
   * An official update Stella is taking by itself. "merging" names the draft
   * an agent is preparing; "done" is the short line after one landed.
   */
  private updateState:
    | { state: "merging"; name: string; since: number }
    | { state: "done"; since: number }
    | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private takingUpdate = false;
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
    if (this.updateTimer) clearTimeout(this.updateTimer);
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
      // An official update merged with the user's changes isn't a change
      // they asked for: it stays out of the chat and off their other computers.
      if (!isUpdateDraft(name)) await this.rememberAgent(cwd, name, tip);
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
    // Best-effort: without the tag the change only goes unannounced elsewhere.
    const tag = await gitRaw(
      cwd,
      [
        "tag",
        "--force",
        "--annotate",
        `--message=${deviceName()}`,
        `${CHANGE_TAG}${Buffer.from(agentId).toString("hex")}`,
        sha,
      ],
      { env: await this.identityEnv(cwd) },
    );
    if (tag.code !== 0) {
      this.options.log("app-source.change-tag-failed", { message: tag.stderr.trim() });
    }
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
   * Take the published app's update.
   *
   * A fast-forward applies. A diverged update that git merges without a
   * conflict also applies, by itself: the merge is computed into the object
   * database, checked on a scratch worktree, and only then fast-forwarded in.
   * Divergence on its own is not a reason to involve anybody — a checkout
   * whose tree already matches the upstream commit it last merged has no
   * merge judgement in it to make. Only a real textual conflict, or a merge
   * that does not build, goes to an agent.
   */
  applyUpstream() {
    return this.exclusive(async (cwd) => {
      if (!this.upstreamTracked) throw new Error("No update is available.");
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const plan = await classifyUpdate(cwd, head, UPSTREAM_REF);
      this.options.log("app-source.update-planned", {
        kind: plan.kind,
        ...(plan.kind === "clean"
          ? { identical: plan.identical, localChanges: plan.localChanges }
          : {}),
        ...(plan.kind === "conflict" ? { conflicts: plan.conflicts.length } : {}),
      });
      if (plan.kind === "none") throw new Error("No update is available.");
      if (plan.kind === "fast-forward") {
        await git(cwd, ["merge", "--ff-only", plan.tip]);
        await this.swapIn(cwd, head, plan.tip);
        return;
      }
      if (plan.kind === "conflict") return await this.escalateUpdate(cwd, plan, head);
      // The merge exists as objects only: nothing is checked out and the
      // checkout's branch has not moved, so giving up here leaves no state.
      const merged = await git(
        cwd,
        [
          "commit-tree",
          plan.tree,
          "-p",
          head,
          "-p",
          plan.tip,
          "-m",
          `Merge the published Stella update ${plan.tip.slice(0, 12)}`,
        ],
        { env: await this.identityEnv(cwd) },
      );
      // Nothing of the user's survived into the result that upstream has not
      // already published and shipped: there is nothing left to check.
      if (!plan.identical) {
        const gate = await checkMergedUpdate(
          cwd,
          merged,
          this.options.updateScratchDir,
          this.options.log,
        );
        if (!gate.ok) {
          return await this.escalateUpdate(cwd, plan, head, gate.output);
        }
      }
      // No line in the chat for this: it applied while the user watched the
      // button, exactly like a fast-forward. The two lines belong to the
      // update that had to go on in the background.
      await git(cwd, ["merge", "--ff-only", merged]);
      await this.swapIn(cwd, head, merged);
    });
  }

  /**
   * Hand the merge to a background agent and report the action as going on in
   * the background. No user turn is fabricated for it: the agent's brief
   * carries the shas, the divergence and the conflicting files the app
   * already knows, so nothing has to be re-derived from a sentence the user
   * never typed.
   */
  private async escalateUpdate(
    cwd: string,
    plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
    head: string,
    gateOutput?: string,
  ): Promise<{ background: true }> {
    const dispatch = this.options.dispatchUpdateMerge;
    if (!dispatch) {
      throw new Error("This update isn't ready to install yet.");
    }
    const name = updateDraftName(plan.tip);
    // A merge for this very version is already under way (an earlier press,
    // or a relaunch that forgot it): wait for that one instead of a second
    // agent on the same work.
    const existing =
      (await gitRaw(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${DRAFT_REF_PREFIX}${name}^{commit}`,
      ])).code === 0;
    if (!existing) {
      await dispatch(updateBrief(plan, head, gateOutput));
      this.options.log("app-source.update-dispatched", {
        tip: plan.tip,
        reason: plan.kind === "conflict" ? "conflict" : "check-failed",
      });
    }
    this.updateState = { state: "merging", name, since: Date.now() };
    return { background: true };
  }

  /** The update landed: say so once, briefly, then stop saying anything. */
  private finishUpdate() {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateState = { state: "done", since: Date.now() };
    this.updateTimer = setTimeout(() => {
      this.updateState = null;
      void this.refresh();
    }, UPDATE_DONE_MS);
    this.updateTimer.unref?.();
  }

  /**
   * The agent's merge is ready: take it. Pressing Update was the go-ahead, so
   * nothing asks again. A merge that never arrives is forgotten after a while
   * rather than leaving the chat saying Stella is updating forever.
   */
  private takeFinishedUpdate(state: Omit<AppSourceState, "busy">) {
    const pending = this.updateState;
    if (pending?.state !== "merging") return;
    if (Date.now() - pending.since > UPDATE_MERGE_WAIT_MS) {
      this.updateState = null;
      return;
    }
    if (this.takingUpdate) return;
    if (!state.ready.some((draft) => draft.name === pending.name)) return;
    this.takingUpdate = true;
    void this.applyDraft(pending.name)
      .then((result) => {
        if (result.ok) this.finishUpdate();
      })
      .finally(() => {
        this.takingUpdate = false;
      });
  }

  private exclusive(
    task: (cwd: string) => Promise<void | { background: true }>,
  ): Promise<AppSourceActionResult> {
    const result = this.queue.then(async (): Promise<AppSourceActionResult> => {
      this.setBusy(true);
      try {
        await this.options.beforeAction?.(this.options.stellaAppDir);
        const outcome = await task(this.options.stellaAppDir);
        this.pushToFork();
        return { ok: true, ...(outcome ?? {}) };
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
          const next = await this.readState();
          this.publish({ ...next, busy: this.busy });
          this.takeFinishedUpdate(next);
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
    const [remote, upstream, elsewhere] = await Promise.all([
      this.forkBranch
        ? this.compareRef(cwd, head, `${FORK_REF_PREFIX}${this.forkBranch}`)
        : null,
      this.upstreamTracked ? this.compareRef(cwd, head, UPSTREAM_REF) : null,
      this.readElsewhere(cwd),
    ]);
    // The other computer only took the official update: that is the top
    // bar's Update here, not a change of the user's.
    const officialOnly =
      remote !== null &&
      upstream !== null &&
      (await isAncestor(cwd, `${FORK_REF_PREFIX}${this.forkBranch}`, UPSTREAM_REF));
    return {
      ready,
      stale,
      remote:
        remote && !officialOnly
          ? { status: remote.status, count: remote.count }
          : { status: "none", count: 0 },
      upstream: upstream ?? NO_UPSTREAM,
      recent,
      elsewhere,
      ...(this.updateState
        ? { update: { state: this.updateState.state } }
        : {}),
    };
  }

  /**
   * Agents' changes tagged on the owner's other computers (fetched from the
   * fork, minus this computer's own tags), and whether HEAD already has each.
   */
  private async readElsewhere(cwd: string): Promise<AppSourceElsewhere[]> {
    const format = "--format=%(refname)%00%(*objectname)%00%(contents:subject)";
    const [all, merged, own] = await Promise.all([
      git(cwd, ["for-each-ref", format, FORK_CHANGES_PREFIX]),
      git(cwd, ["for-each-ref", "--merged=HEAD", "--format=%(refname)", FORK_CHANGES_PREFIX]),
      git(cwd, ["for-each-ref", "--format=%(refname)", CHANGE_TAG_PREFIX]),
    ]);
    const here = new Set(merged.split("\n"));
    const mine = new Set(
      own.split("\n").map((ref) => ref.slice(CHANGE_TAG_PREFIX.length)),
    );
    const changes: AppSourceElsewhere[] = [];
    for (const line of all.split("\n").filter(Boolean)) {
      const [refname = "", sha = "", device = ""] = line.split("\0");
      const key = refname.slice(FORK_CHANGES_PREFIX.length);
      if (!sha || mine.has(key) || !/^([0-9a-f]{2})+$/.test(key)) continue;
      changes.push({
        agentId: Buffer.from(key, "hex").toString("utf8"),
        sha,
        device,
        here: here.has(refname),
      });
    }
    return changes;
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
        `+${CHANGE_TAG_PREFIX}*:${FORK_CHANGES_PREFIX}*`,
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
    if (forkTip !== head && (await isAncestor(cwd, forkTip, head))) {
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
    await this.pushChangeTags(cwd, fork, ref);
  }

  /** Push this computer's change tags whose change the fork's main now has. */
  private async pushChangeTags(cwd: string, fork: ForkAccess, forkRef: string) {
    const format = "--format=%(refname)%00%(objectname)";
    const [own, pushed] = await Promise.all([
      git(cwd, ["for-each-ref", `--merged=${forkRef}`, format, CHANGE_TAG_PREFIX]),
      git(cwd, ["for-each-ref", format, FORK_CHANGES_PREFIX]),
    ]);
    const onFork = new Set(
      pushed.split("\n").map((line) => line.slice(FORK_CHANGES_PREFIX.length)),
    );
    // A tag moves when the same agent's next change is applied.
    const tags = own
      .split("\n")
      .filter((line) => line && !onFork.has(line.slice(CHANGE_TAG_PREFIX.length)))
      .map((line) => line.split("\0") as [string, string]);
    if (tags.length === 0) return;
    await git(
      cwd,
      ["push", "--quiet", fork.remote, ...tags.map(([name]) => `+${name}:${name}`)],
      { env: pushEnv(fork.token), timeoutMs: 5 * 60_000 },
    );
    for (const [name, object] of tags) {
      const key = name.slice(CHANGE_TAG_PREFIX.length);
      await git(cwd, ["update-ref", `${FORK_CHANGES_PREFIX}${key}`, object]);
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
