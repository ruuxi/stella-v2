import {
  promises as fs,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
  type Stats,
} from "node:fs";
import path from "node:path";

import {
  BackendClient,
  BackendRequestError,
} from "@stella/contracts/backend/client";
import type { MemorySyncListing } from "@stella/contracts/backend/home";
import type {
  MemorySyncEraseResult,
  MemorySyncStatus,
} from "@stella/contracts/desktop/memory-sync";
import {
  CORE_MEMORY_FILE,
  MEMORIES_DIR,
  PERSONALITY_FILE,
} from "@stella/runtime/kernel/memory/memory-layout.js";
import { tokenSubject } from "../engine-account-access.js";
import { LocalMemoryFiles, sha256Hex } from "./local-memory-files.js";
import { memoryMergeBrief, type MemoryMerge } from "./memory-merge-brief.js";
import {
  planMemorySync,
  type MemorySyncAction,
  type SyncedPair,
} from "./memory-sync-plan.js";

/**
 * Keeps this computer's memory files (`~/.stella/core-memory.md`,
 * `memories/**.md`, `PERSONALITY.md`) the same as the owner's cloud copy in
 * their world, both ways. Every computer syncs with the cloud on its own;
 * the cloud is the hub. Runs in Electron main, off the UI thread.
 *
 * State (`<data>/memory-sync/state.json`): the account and memory epoch this
 * computer last synced in, and per file the sha each side had when they were
 * last the same. A pass lists both sides and carries out
 * `planMemorySync`; every write and delete on either side is
 * compare-and-set against what the pass saw, so a change made meanwhile is
 * never overwritten: the pass stops short and runs again.
 *
 * Conflicts (a file changed on both sides): the cloud's version is put in
 * place here, this computer's version is saved under
 * `<data>/memory-sync/conflicts/` (outside `memories/`, so no turn reads it as
 * memory), and a background agent is briefed to merge the two into the file.
 * Its edit is then an ordinary local change that the next pass uploads.
 *
 * Epochs: a wipe opens a new cloud memory epoch. Memory this computer kept
 * from before it goes up only once the owner allowed it
 * (`memory.authorizeReimport`); until then the sync holds (no upload, no
 * download) and offers to erase it here instead. A computer that never synced
 * joins the same way: its existing memory merges in unless the account was
 * wiped and not re-authorized. `~/.stella` is not per account, so this
 * computer's memory stays with the first account it synced with; signed in
 * to another, the sync holds rather than hand one account's memory to it.
 *
 * Passes run on sign-in, on local file changes (debounced watcher), every few
 * minutes, when a window gains focus, on request, and once more before quit.
 * Signed out, or memory off in the cloud: nothing syncs.
 */

const STATE_DIR = "memory-sync";
const STATE_FILE = "state.json";
const CONFLICTS_DIR = "conflicts";

const PERIODIC_MS = 3 * 60_000;
const FOCUS_MIN_GAP_MS = 30_000;
const LOCAL_DEBOUNCE_MS = 1_500;
/** Stat polling for `core-memory.md`, `PERSONALITY.md` and `memories/` itself. */
const POLL_MS = 2_000;
const SIGN_IN_DELAY_MS = 1_000;
/** A pass that met a concurrent change runs again this soon, a few times. */
const UNSETTLED_RETRY_MS = 5_000;
const UNSETTLED_RETRIES = 3;
const ERROR_RETRY_MS = 60_000;
const NOT_READY_RETRY_MS = 30_000;
/** How long a handed-off merge counts as in progress. */
const MERGE_SHOWN_MS = 24 * 60 * 60_000;

type PendingMerge = MemoryMerge & { dispatchedAt: number | null };

type SyncState = {
  version: 1;
  /** The account this computer's memory syncs with. */
  owner: string | null;
  /** The cloud memory epoch the files below were synced in. */
  epoch: string | null;
  files: Record<string, SyncedPair>;
  /** Local shas the cloud refused (over a cap); retried once they change. */
  refused: Record<string, string>;
  merges: PendingMerge[];
  lastSyncedAt: number | null;
};

const emptyState = (): SyncState => ({
  version: 1,
  owner: null,
  epoch: null,
  files: {},
  refused: {},
  merges: [],
  lastSyncedAt: null,
});

const isPair = (value: unknown): value is SyncedPair =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SyncedPair).local === "string" &&
  typeof (value as SyncedPair).cloud === "string";

const parseState = (raw: string): SyncState => {
  const value = JSON.parse(raw) as Partial<SyncState>;
  if (value.version !== 1) return emptyState();
  const files: Record<string, SyncedPair> = {};
  for (const [file, pair] of Object.entries(value.files ?? {})) {
    if (isPair(pair)) files[file] = { local: pair.local, cloud: pair.cloud };
  }
  const refused: Record<string, string> = {};
  for (const [file, sha] of Object.entries(value.refused ?? {})) {
    if (typeof sha === "string") refused[file] = sha;
  }
  return {
    version: 1,
    owner: typeof value.owner === "string" ? value.owner : null,
    epoch: typeof value.epoch === "string" ? value.epoch : null,
    files,
    refused,
    merges: Array.isArray(value.merges)
      ? value.merges.filter(
          (merge): merge is PendingMerge =>
            typeof merge?.path === "string" && typeof merge.copy === "string",
        )
      : [],
    lastSyncedAt:
      typeof value.lastSyncedAt === "number" ? value.lastSyncedAt : null,
  };
};

/** Refusals that end a pass: the cloud's memory is not open to this sync. */
const STOP_REASONS = new Set([
  "CLOUD_MEMORY_OFF",
  "CLOUD_MEMORY_WIPE_ACTIVE",
  "CLOUD_MEMORY_EPOCH_STALE",
  "CLOUD_MEMORY_REIMPORT_REQUIRED",
  "MEMORY_POLICY_CHANGING",
]);

class PassStopped extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type MemorySyncServiceOptions = {
  stellaDataDir: string;
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  hasConnectedAccount: () => boolean;
  /** Start a background agent on a brief; throws when none can start yet. */
  dispatchAgentBrief: (brief: {
    description: string;
    prompt: string;
  }) => Promise<void>;
  broadcast: (status: MemorySyncStatus) => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

export class MemorySyncService {
  private readonly local: LocalMemoryFiles;
  private readonly stateDir: string;
  private client: { baseUrl: string; value: BackendClient } | null = null;
  private subject: string | null = null;
  private status: MemorySyncStatus = {
    phase: "signed_out",
    lastSyncedAt: null,
    merging: 0,
    refused: [],
  };
  private pendingMode: "full" | "local" | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private unsettledRuns = 0;
  private lastFullPassAt = 0;
  private polled: Array<() => void> = [];
  private memoriesWatcher: FSWatcher | null = null;
  private disposed = false;
  /** The account the running pass started in; its requests use only it. */
  private passSubject: string | null = null;

  constructor(private readonly options: MemorySyncServiceOptions) {
    this.local = new LocalMemoryFiles(options.stellaDataDir);
    this.stateDir = path.join(options.stellaDataDir, STATE_DIR);
  }

  getStatus(): MemorySyncStatus {
    return this.status;
  }

  /** The Stella session changed: start for a new account, stop when signed out. */
  noteAuthToken(token: string | null): void {
    const next = tokenSubject(token);
    if (next === this.subject || this.disposed) return;
    this.subject = next;
    if (!next) {
      this.stop();
      this.publish({ phase: "signed_out", merging: 0, refused: [] });
      return;
    }
    this.start();
    this.request("full", SIGN_IN_DELAY_MS);
  }

  noteWindowFocus(): void {
    if (!this.subject || Date.now() - this.lastFullPassAt < FOCUS_MIN_GAP_MS) {
      return;
    }
    this.request("full", 0);
  }

  /** Run a full pass now and answer the status it ended in. */
  async syncNow(): Promise<MemorySyncStatus> {
    await this.running?.catch(() => undefined);
    this.request("full", 0);
    this.kick();
    await this.running?.catch(() => undefined);
    return this.status;
  }

  /**
   * While held after a wipe: erase this computer's memory files and join the
   * cloud's current memory instead of uploading them.
   */
  async eraseLocal(): Promise<MemorySyncEraseResult> {
    await this.running?.catch(() => undefined);
    if (this.status.phase !== "held" || this.status.heldReason !== "wiped") {
      return { ok: false, error: "This computer's memory is not on hold." };
    }
    const work = (async () => {
      const files = await this.local.scan();
      for (const relative of files.keys()) {
        await fs.rm(this.local.absolute(relative), { force: true });
      }
      const state = await this.loadState();
      await this.saveState({ ...emptyState(), owner: state.owner });
      this.log("memory_sync.erased_local", { files: files.size });
    })();
    this.running = work.catch(() => undefined);
    try {
      await work;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.running = null;
    }
    await this.syncNow();
    return { ok: true };
  }

  /** Before quit: let a pending or running pass finish, briefly. */
  async flush(timeoutMs: number): Promise<void> {
    if (this.pendingMode && this.subject) this.kick();
    const running = this.running;
    if (!running) return;
    await Promise.race([
      running.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.client?.value.dispose();
    this.client = null;
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  private start(): void {
    if (!this.periodic) {
      this.periodic = setInterval(
        () => this.request("full", 0),
        PERIODIC_MS,
      );
    }
    if (this.polled.length === 0) this.watchFiles();
  }

  private stop(): void {
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingMode = null;
    for (const unwatch of this.polled) unwatch();
    this.polled = [];
    this.memoriesWatcher?.close();
    this.memoriesWatcher = null;
  }

  /**
   * `memories/` gets a recursive watcher. The two files beside it, and
   * `memories/` itself appearing or going, are polled by stat instead: a
   * watcher on `~/.stella` would wake on every database write there.
   */
  private watchFiles(): void {
    const onChange = () => this.request("local", LOCAL_DEBOUNCE_MS);
    const memoriesDir = path.join(this.options.stellaDataDir, MEMORIES_DIR);
    const watchMemories = () => {
      if (this.memoriesWatcher) return;
      try {
        this.memoriesWatcher = watch(memoriesDir, { recursive: true }, onChange);
        this.memoriesWatcher.on("error", () => {
          this.memoriesWatcher?.close();
          this.memoriesWatcher = null;
        });
      } catch {
        // No memories/ yet; polling attaches the watcher when it appears.
      }
    };
    const poll = (file: string, changed: (exists: boolean) => void) => {
      const listener = (current: Stats, previous: Stats) => {
        if (
          current.ino !== previous.ino ||
          current.mtimeMs !== previous.mtimeMs ||
          current.size !== previous.size
        ) {
          changed(current.ino !== 0);
        }
      };
      watchFile(file, { interval: POLL_MS, persistent: false }, listener);
      this.polled.push(() => unwatchFile(file, listener));
    };
    for (const name of [CORE_MEMORY_FILE, PERSONALITY_FILE]) {
      poll(path.join(this.options.stellaDataDir, name), onChange);
    }
    poll(memoriesDir, (exists) => {
      if (exists) watchMemories();
      else {
        this.memoriesWatcher?.close();
        this.memoriesWatcher = null;
      }
      onChange();
    });
    watchMemories();
  }

  /**
   * Ask for a pass. A full one supersedes a local one. Local edits debounce
   * each other; otherwise a pass already due sooner keeps its time.
   */
  private request(mode: "full" | "local", delayMs: number): void {
    if (this.disposed || !this.subject) return;
    const due = Date.now() + delayMs;
    const debounce = mode === "local" && this.pendingMode === "local";
    this.pendingMode =
      mode === "full" || this.pendingMode === "full" ? "full" : "local";
    if (this.timer !== null && !debounce && this.dueAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delayMs);
  }

  private kick(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    const mode = this.pendingMode;
    this.pendingMode = null;
    if (!mode || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.pass(mode)
      .catch((error: unknown) => {
        // The account changed mid-pass; the new account's own pass follows.
        if (!(error instanceof PassStopped)) throw error;
        this.log("memory_sync.stopped", { reason: error.reason });
        this.request("full", UNSETTLED_RETRY_MS);
      })
      .catch((error: unknown) => {
        this.log("memory_sync.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.publish({ phase: "error" });
        this.request("full", ERROR_RETRY_MS);
      })
      .finally(() => {
        this.passSubject = null;
        this.running = null;
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  // ── One pass ─────────────────────────────────────────────────────────────

  private backend(): BackendClient | null {
    const baseUrl = this.options.getBackendUrl();
    if (!baseUrl) return null;
    if (this.client?.baseUrl !== baseUrl) {
      this.client?.value.dispose();
      this.client = {
        baseUrl,
        value: new BackendClient({
          baseUrl,
          // A pass is bound to the account it started in: a request made
          // after a switch would carry another account's credentials.
          getToken: async () => {
            const token = await this.options.getAuthToken();
            if (!this.passSubject || tokenSubject(token) !== this.passSubject) {
              throw new PassStopped("ACCOUNT_CHANGED");
            }
            return token;
          },
        }),
      };
    }
    return this.client.value;
  }

  private async pass(mode: "full" | "local"): Promise<void> {
    const subject = this.subject;
    const backend = this.backend();
    if (!subject || !backend || !this.options.hasConnectedAccount()) {
      this.publish({ phase: "signed_out", merging: 0, refused: [] });
      // A session that is still settling (or a guest one) is looked at again.
      if (subject) this.request("full", NOT_READY_RETRY_MS);
      return;
    }
    this.passSubject = subject;
    let state = await this.loadState();
    if (state.owner !== null && state.owner !== subject) {
      this.publish({ phase: "held", heldReason: "other_account" });
      return;
    }
    const local = await this.local.scan();
    if (
      mode === "local" &&
      state.epoch !== null &&
      this.matchesState(state, local)
    ) {
      return;
    }

    let listing: MemorySyncListing;
    try {
      listing = await backend.call("memory.files.list", {});
    } catch (error) {
      const reason = error instanceof BackendRequestError ? error.reason : "";
      if (reason && STOP_REASONS.has(reason)) {
        this.publish({ phase: "off" });
        return;
      }
      throw error;
    }
    this.lastFullPassAt = Date.now();

    const inEpoch = state.owner === subject && state.epoch === listing.memoryEpoch;
    const importing = !inEpoch && local.size > 0;
    if (importing && listing.importDisposition === "explicit_required") {
      this.publish({ phase: "held", heldReason: "wiped" });
      return;
    }
    if (!inEpoch) {
      state = { ...emptyState(), owner: subject, lastSyncedAt: state.lastSyncedAt };
    }

    const cloud = new Map(listing.files.map((file) => [file.path, file.sha]));
    const files: Record<string, SyncedPair> = { ...state.files };
    const refused: Record<string, string> = {};
    for (const [file, sha] of Object.entries(state.refused)) {
      if (local.get(file) === sha) refused[file] = sha;
    }
    const merges = [...state.merges];
    const actions = planMemorySync(state.files, local, cloud).filter(
      (action) =>
        action.kind !== "push" || refused[action.path] !== action.localSha,
    );
    if (actions.length > 0) this.publish({ phase: "syncing" });
    const context = {
      backend,
      epoch: listing.memoryEpoch,
      importing,
      files,
      refused,
      merges,
    };
    let settled = true;
    try {
      for (const action of actions) {
        if (!(await this.apply(action, context))) settled = false;
      }
    } catch (error) {
      // Refused mid-pass (a wipe began, memory went off): keep only what
      // already landed, under the epoch it landed in, and look again soon.
      if (error instanceof PassStopped) {
        await this.saveState({ ...state, files, refused, merges });
        this.log("memory_sync.stopped", { reason: error.reason });
        this.request("full", UNSETTLED_RETRY_MS);
        return;
      }
      await this.saveState({ ...state, files, refused, merges });
      throw error;
    }

    state = {
      ...state,
      owner: subject,
      epoch: listing.memoryEpoch,
      files,
      refused,
      merges: await this.handOffMerges(merges),
      lastSyncedAt: settled ? Date.now() : state.lastSyncedAt,
    };
    await this.saveState(state);
    this.publish({
      phase: "synced",
      lastSyncedAt: state.lastSyncedAt,
      merging: state.merges.length,
      refused: Object.keys(refused).sort(),
    });
    if (settled) {
      this.unsettledRuns = 0;
    } else if (this.unsettledRuns < UNSETTLED_RETRIES) {
      // Something changed while the pass ran; it stopped short of it.
      this.unsettledRuns += 1;
      this.request("full", UNSETTLED_RETRY_MS);
    }
  }

  /** Whether nothing here changed since the last pass. */
  private matchesState(state: SyncState, local: Map<string, string>): boolean {
    if (Object.keys(state.files).some((file) => !local.has(file))) {
      return false;
    }
    for (const [file, sha] of local) {
      if (state.files[file]?.local !== sha && state.refused[file] !== sha) {
        return false;
      }
    }
    return true;
  }

  private async callCloud<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof BackendRequestError &&
        error.reason &&
        STOP_REASONS.has(error.reason)
      ) {
        throw new PassStopped(error.reason);
      }
      throw error;
    }
  }

  /** Carry out one action; false when the file moved under it. */
  private async apply(
    action: MemorySyncAction,
    context: {
      backend: BackendClient;
      epoch: string;
      importing: boolean;
      files: Record<string, SyncedPair>;
      refused: Record<string, string>;
      merges: PendingMerge[];
    },
  ): Promise<boolean> {
    const { backend, epoch, files } = context;
    const fence = { expectedMemoryEpoch: epoch };
    switch (action.kind) {
      case "record":
        files[action.path] = action.pair;
        return true;
      case "forget":
        delete files[action.path];
        return true;
      case "push": {
        const bytes = await this.local.read(action.path);
        if (bytes === null || sha256Hex(bytes) !== action.localSha) return false;
        try {
          const outcome = await this.callCloud(() =>
            backend.call("memory.files.write", {
              ...fence,
              path: action.path,
              content: decoder.decode(bytes),
              expectSha: action.expectCloud,
              importing: context.importing,
            }),
          );
          if (outcome.status === "conflict") return false;
          files[action.path] = { local: action.localSha, cloud: outcome.sha };
          delete context.refused[action.path];
          return true;
        } catch (error) {
          if (
            error instanceof BackendRequestError &&
            error.reason === "CLOUD_MEMORY_FILE_REFUSED"
          ) {
            context.refused[action.path] = action.localSha;
            this.log("memory_sync.refused", { path: action.path });
            return true;
          }
          throw error;
        }
      }
      case "pull": {
        const remote = await this.callCloud(() =>
          backend.call("memory.files.read", { ...fence, path: action.path }),
        );
        if (remote === null) return false;
        const bytes = encoder.encode(remote.content);
        if (!(await this.local.write(action.path, bytes, action.expectLocal))) {
          return false;
        }
        files[action.path] = { local: sha256Hex(bytes), cloud: remote.sha };
        return true;
      }
      case "deleteCloud": {
        const outcome = await this.callCloud(() =>
          backend.call("memory.files.delete", {
            ...fence,
            path: action.path,
            expectSha: action.expectCloud,
          }),
        );
        if (outcome.status === "conflict") return false;
        delete files[action.path];
        return true;
      }
      case "deleteLocal":
        if (!(await this.local.remove(action.path, action.expectLocal))) {
          return false;
        }
        delete files[action.path];
        return true;
      case "conflict": {
        const remote = await this.callCloud(() =>
          backend.call("memory.files.read", { ...fence, path: action.path }),
        );
        const mine = await this.local.read(action.path);
        if (remote === null || mine === null || sha256Hex(mine) !== action.localSha) {
          return false;
        }
        if (remote.sha === action.localSha) {
          files[action.path] = { local: action.localSha, cloud: remote.sha };
          return true;
        }
        const copy = await this.saveConflictCopy(action.path, mine);
        const bytes = encoder.encode(remote.content);
        if (!(await this.local.write(action.path, bytes, action.localSha))) {
          await fs.rm(copy, { force: true }).catch(() => undefined);
          return false;
        }
        files[action.path] = { local: sha256Hex(bytes), cloud: remote.sha };
        context.merges.push({ path: action.path, copy, dispatchedAt: null });
        this.log("memory_sync.conflict", { path: action.path });
        return true;
      }
    }
  }

  /** Save this computer's side of a conflict where no turn reads memory. */
  private async saveConflictCopy(
    relative: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const copy = path.join(
      this.stateDir,
      CONFLICTS_DIR,
      stamp,
      ...relative.split("/"),
    );
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, bytes, { mode: 0o600 });
    return copy;
  }

  /**
   * Brief one background agent with every conflict not yet handed off. A
   * merge stays listed while its saved copy exists (the agent deletes it when
   * done), for a day at most; an agent that cannot start yet is tried again
   * next pass, and the saved copy keeps this computer's version safe either
   * way.
   */
  private async handOffMerges(merges: PendingMerge[]): Promise<PendingMerge[]> {
    const now = Date.now();
    const live: PendingMerge[] = [];
    for (const merge of merges) {
      const exists = await fs
        .stat(merge.copy)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      if (merge.dispatchedAt !== null && now - merge.dispatchedAt > MERGE_SHOWN_MS) {
        continue;
      }
      live.push(merge);
    }
    const waiting = live.filter((merge) => merge.dispatchedAt === null);
    if (waiting.length === 0) return live;
    try {
      await this.options.dispatchAgentBrief(
        memoryMergeBrief(this.options.stellaDataDir, waiting),
      );
      for (const merge of waiting) merge.dispatchedAt = now;
      this.log("memory_sync.merge_dispatched", { files: waiting.length });
    } catch (error) {
      this.log("memory_sync.merge_dispatch_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return live;
  }

  // ── State and status ─────────────────────────────────────────────────────

  private async loadState(): Promise<SyncState> {
    try {
      return parseState(
        await fs.readFile(path.join(this.stateDir, STATE_FILE), "utf8"),
      );
    } catch {
      return emptyState();
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, STATE_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  }

  private publish(patch: Partial<MemorySyncStatus>): void {
    const next: MemorySyncStatus = { ...this.status, ...patch };
    if (next.phase !== "held") delete next.heldReason;
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.options.broadcast(next);
  }

  private log(event: string, data?: Record<string, unknown>): void {
    this.options.log?.(event, data);
  }
}
