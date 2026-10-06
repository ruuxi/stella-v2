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

/**
 * An agent's change applied on another of the owner's computers (shared
 * through the fork). The chat shows it on that agent's completion, where the
 * user adds it to this computer with a click; nothing applies it on its own.
 */
export type AppSourceElsewhere = {
  agentId: string;
  sha: string;
  /** The computer it was applied on. */
  device: string;
  /** This computer already runs it. */
  here: boolean;
};

/**
 * A draft merging the published app (upstream) with the user's own changes
 * (the modify-stella skill names it `update-<sha12>`). It is an official
 * update, so it goes through the top bar's Update, never the chat.
 */
export const isUpdateDraft = (name: string) => name.startsWith("update-");

export type AppSourceState = {
  /** Finished drafts that fast-forward the current branch. */
  ready: AppSourceDraft[];
  /** Finished drafts whose base moved; an agent has to rebase them. */
  stale: AppSourceDraft[];
  /** The fork compared with the current branch. */
  remote: { status: "none" | "ahead" | "diverged"; count: number };
  /**
   * The published app (upstream `main`) compared with the current branch:
   * "ahead" fast-forwards, "diverged" has to be merged with the user's own
   * changes. A diverged update that git merges cleanly is still taken without
   * asking anyone (see `update`); only a real conflict reaches an agent.
   */
  upstream: {
    status: "none" | "ahead" | "diverged";
    count: number;
    /** Subject of upstream's newest commit. */
    subject: string;
  };
  /**
   * An official update Stella is taking by itself, for the one line the chat
   * shows about it: "merging" while it runs, "done" for a short while after
   * it lands. There is nothing for the user to do in either state, and the
   * reason it takes a while is never shown to them.
   */
  update?: { state: "merging" | "done" };
  /** Recent first-parent commits on the current branch, newest first. */
  recent: AppSourceCommit[];
  /** Agents' changes applied on the owner's other computers. */
  elsewhere: AppSourceElsewhere[];
  /** An apply or undo is running. */
  busy: boolean;
};

export type AppSourceActionResult =
  | {
      ok: true;
      /**
       * The action did not finish in place: it is going on in the background
       * and the state's `update` reports it. The caller shows no progress of
       * its own.
       */
      background?: boolean;
    }
  | { ok: false; error: string; conflict?: boolean };
