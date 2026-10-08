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

/**
 * One row of the Updates history: what one move of the checkout brought.
 * Commits that arrived together (a draft's commits, a catch-up with the
 * fork) are one row, named by the newest, and Undo takes all of them out.
 */
export type AppSourceCommit = {
  /** The newest commit of the row. */
  sha: string;
  subject: string;
  /** Commit time, ms since epoch. */
  date: number;
  /** The agent whose change this commit applied or undid, when it was one. */
  agentId?: string;
  /** The commit undoes the agent's change (an Undo); Update takes it again. */
  undone?: boolean;
  /**
   * What the commit brought, for the Updates list: a new published version,
   * changes taken from the owner's other computer, or a change of their own.
   * Only the last two can be undone from there.
   */
  kind: "version" | "other-computer" | "change";
};

/**
 * Something this computer can add, as the Updates list shows it. Each has a
 * `key` that names exactly this offer: skipping it moves that key to the
 * skipped list, and a newer version or another change arriving makes a new
 * key, so it shows as waiting again.
 * `adding` is one already added whose work is still going on in the
 * background; it no longer counts as waiting.
 */
export type AppSourceWaiting =
  | { kind: "version"; key: string; adding: boolean; draft?: string }
  | {
      kind: "other-computer";
      key: string;
      adding: boolean;
      /** The computer it was made on, when the change says. */
      device: string;
      /** One line on what it changes. */
      summary: string;
    }
  | { kind: "draft"; key: string; adding: boolean; name: string; summary: string };

/**
 * A draft merging the published app (upstream) with the user's own changes
 * (the modify-stella skill names it `update-<sha12>`). It is an official
 * update, so it goes through the top bar's Update, never the chat.
 */
export const isUpdateDraft = (name: string) => name.startsWith("update-");

/**
 * A draft Stella dispatched for itself to settle its own version — merging
 * the published update, or a change the owner made on another computer. It is
 * not a change the user asked for: it stays out of the chat, is not announced
 * to their other computers as theirs, and Stella takes it without asking,
 * because pressing the button was the request.
 *
 * Currently the same shape as an official update, and deliberately one
 * predicate rather than a prefix test repeated at four call sites.
 */
export const isStellaDraft = isUpdateDraft;

export type AppSourceState = {
  /** Finished drafts that fast-forward the current branch. */
  ready: AppSourceDraft[];
  /** Finished drafts whose base moved; an agent has to rebase them. */
  stale: AppSourceDraft[];
  /**
   * The fork compared with the current branch, counting only a fork that
   * would change files here beyond the published version.
   */
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
  /**
   * Recent first-parent commits on the current branch, newest first, leaving
   * out ones that changed no files.
   */
  recent: AppSourceCommit[];
  /** What this computer can add now, minus what the user skipped. */
  waiting: AppSourceWaiting[];
  /** What the user skipped and can still add. */
  skipped: AppSourceWaiting[];
  /** An apply or undo is running. */
  busy: boolean;
};

export type AppSourceActionResult =
  | {
      ok: true;
      /**
       * The action did not finish in place: it is going on in the background
       * and the state's `update` reports it. The caller shows no progress of
       * its own, and never asks a follow-up question — deciding that an agent
       * is needed is the main process's job, not the caller's.
       */
      background?: boolean;
    }
  | { ok: false; error: string };
