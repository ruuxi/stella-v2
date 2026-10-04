/**
 * The app's own source checkout when Stella runs from source (v3). Agents
 * prepare changes as drafts (git worktrees on `draft/<name>` branches); the
 * user applies them, undoes recent ones, and takes changes made on their other
 * computers through the user's fork, and takes updates from the published app
 * (upstream). Git is the only bookkeeping.
 */

export type AppSourceDraft = {
  name: string;
  /** Subject of the draft's tip commit. */
  subject: string;
  sha: string;
  /**
   * The agent thread whose shell last moved the draft's branch, so the chat
   * can offer it on that agent's completion. Absent for drafts made by hand.
   */
  agentId?: string;
  /** Files the draft changes against the current version. */
  files: number;
  /** Taking the draft restarts Stella (it changes Electron main or preload). */
  restart: boolean;
};

export type AppSourceCommit = {
  sha: string;
  subject: string;
  /** Commit time, ms since epoch. */
  date: number;
  /** The agent whose change this commit applied or undid, when it was one. */
  agentId?: string;
  /** The commit undoes the agent's change (an Undo); Update takes it again. */
  undone?: boolean;
};

export type AppSourceState = {
  /** Finished drafts that fast-forward the current branch. */
  ready: AppSourceDraft[];
  /** Finished drafts whose base moved; an agent has to rebase them. */
  stale: AppSourceDraft[];
  /** The fork compared with the current branch. */
  remote: { status: "none" | "ahead" | "diverged"; count: number };
  /**
   * The published app (upstream `main`) compared with the current branch:
   * "ahead" fast-forwards, "diverged" needs an agent to merge it.
   */
  upstream: {
    status: "none" | "ahead" | "diverged";
    count: number;
    /** Subject of upstream's newest commit. */
    subject: string;
  };
  /** Recent first-parent commits on the current branch, newest first. */
  recent: AppSourceCommit[];
  /** An apply or undo is running. */
  busy: boolean;
};

export type AppSourceActionResult =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean };
