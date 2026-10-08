import { DurableObject } from "cloudflare:workers";
import { WorkspaceApps } from "./workspace-apps.js";
import { WorldSqlStore } from "./world/store.js";
import type { StoredDependencyBackup } from "./sandbox-dependencies.js";
import type { WorldListingEntry, WorldToolCall } from "./world/types.js";

/**
 * A filesystem snapshot of one of this owner's agent containers, the image it
 * was taken on, and the sandbox object it came from.
 */
export type ContainerSnapshot = {
  id: string;
  size: number;
  image: string;
  takenAt: number;
  sandbox: string;
};

const CONTAINER_SNAPSHOT_KEY = "containerSnapshot";
const DEPENDENCY_BACKUP_KEY = "dependencyBackup";

export class WorldStore extends DurableObject<Env> {
  private readonly world: WorldSqlStore;
  private readonly apps: WorkspaceApps;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.world = new WorldSqlStore(ctx.storage.sql, env.WORLDS_BUCKET);
    this.apps = new WorkspaceApps(this.world, ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.world.initialize();
      return Promise.resolve();
    });
  }

  stat(path: string) {
    return this.world.stat(path);
  }

  list(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    return this.world.list(prefix, options);
  }

  readFile(
    path: string,
    options: { offset?: number; length?: number } = {},
  ) {
    return this.world.readFile(path, options);
  }

  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode?: number; mtime?: number } = {},
  ) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.writeFile(path, bytes, options),
    );
  }

  putBlobs(stream: ReadableStream<Uint8Array>) {
    return this.world.putBlobs(stream);
  }

  putBlob(
    stream: ReadableStream<Uint8Array>,
    input: { sha256: string; size: number },
  ) {
    return this.world.putBlob(stream, input);
  }

  mkdir(path: string, options: { mode?: number } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.mkdir(path, options),
    );
  }

  remove(path: string, options: { recursive?: boolean } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.remove(path, options),
    );
  }

  rename(from: string, to: string) {
    return this.ctx.blockConcurrencyWhile(() => this.world.rename(from, to));
  }

  symlink(path: string, target: string) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.symlink(path, target),
    );
  }

  async tool(call: WorldToolCall) {
    const result = await (call.name === "Read" ||
    call.name === "Grep" ||
    call.name === "glob"
      ? this.world.tool(call)
      : this.ctx.blockConcurrencyWhile(() => this.world.tool(call)));
    if (
      result.ok &&
      call.name !== "Read" &&
      call.name !== "Grep" &&
      call.name !== "glob" &&
      JSON.stringify(call.arguments).includes("stella.app.json")
    ) {
      const apps = await this.apps.reconcile();
      return {
        ...result,
        output: result.output + "\nApp build status: " + JSON.stringify(apps),
      };
    }
    return result;
  }

  listWorkspaceApps() {
    return this.apps.reconcile();
  }
  workspaceAppPreview(slug: string, revision: string) {
    return this.apps.preview(slug, revision);
  }
  putWorkspaceAppPreview(slug: string, revision: string, bytes: Uint8Array) {
    return this.apps.putPreview(slug, revision, bytes);
  }
  fetchWorkspaceApp(slug: string, request: Request) {
    return this.apps.fetch(slug, request);
  }

  async checkpoint(options: { historyCursor: string }) {
    const result = await this.ctx.blockConcurrencyWhile(() =>
      this.world.checkpoint(options),
    );
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return result;
  }

  manifest(
    manifestId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    return this.world.manifest(manifestId, options);
  }

  head() {
    return this.world.head();
  }

  // ---- the owner's agent containers --------------------------------------
  //
  // Every agent thread has a container of its own. They share one latest
  // snapshot and one caches-and-dependencies archive, kept here beside the
  // world they all sync: whichever container released last wrote them, and
  // every new container starts from them. The world itself comes down by
  // sync either way, so a snapshot only ever saves setup, never truth.

  containerSnapshot(): ContainerSnapshot | null {
    return (
      this.ctx.storage.kv.get<ContainerSnapshot>(CONTAINER_SNAPSHOT_KEY) ?? null
    );
  }

  recordContainerSnapshot(snapshot: ContainerSnapshot): void {
    this.ctx.storage.kv.put(CONTAINER_SNAPSHOT_KEY, snapshot);
  }

  /**
   * Forget the latest snapshot if it is the one named: by its id after a
   * restore from it failed, or by the container it came from when that
   * container's state is being discarded. A newer one is kept.
   */
  forgetContainerSnapshot(match: { id?: string; sandbox?: string }): void {
    const current = this.containerSnapshot();
    if (
      current &&
      ((match.id !== undefined && current.id === match.id) ||
        (match.sandbox !== undefined && current.sandbox === match.sandbox))
    ) {
      this.ctx.storage.kv.delete(CONTAINER_SNAPSHOT_KEY);
    }
  }

  dependencyBackup(): StoredDependencyBackup | null {
    return (
      this.ctx.storage.kv.get<StoredDependencyBackup>(DEPENDENCY_BACKUP_KEY) ??
      null
    );
  }

  /** Make `next` the archive new containers restore; returns the one replaced. */
  replaceDependencyBackup(
    next: StoredDependencyBackup,
  ): StoredDependencyBackup | null {
    const previous = this.dependencyBackup();
    this.ctx.storage.kv.put(DEPENDENCY_BACKUP_KEY, next);
    return previous;
  }

  /** Forget the archive if it is still `record`, which no longer restores. */
  forgetDependencyBackup(recordId: string): void {
    if (this.dependencyBackup()?.record.id === recordId) {
      this.ctx.storage.kv.delete(DEPENDENCY_BACKUP_KEY);
    }
  }

  /** Owner purge: no later container may start from either. */
  forgetContainerState(): void {
    this.ctx.storage.kv.delete(CONTAINER_SNAPSHOT_KEY);
    this.ctx.storage.kv.delete(DEPENDENCY_BACKUP_KEY);
  }

  /** One agent container's own changes (`WorldSqlStore.pushChanges`). */
  async pushChanges(input: {
    entries: WorldListingEntry[];
    deleted: string[];
  }) {
    const result = await this.ctx.blockConcurrencyWhile(() =>
      this.world.pushChanges(input),
    );
    if (
      result.revision !== result.previousRevision &&
      [...input.entries.map((entry) => entry.path), ...input.deleted].some(
        (path) =>
          path === "stella.app.json" || path.endsWith("/stella.app.json"),
      )
    )
      await this.apps.reconcile();
    return result;
  }

  async pushDiff(input: {
    entries: WorldListingEntry[];
    deleted: string[];
  }) {
    const result = await this.ctx.blockConcurrencyWhile(() =>
      this.world.pushDiff(input),
    );
    if (input.entries.some((e) => e.path.endsWith("/stella.app.json")))
      await this.apps.reconcile();
    return result;
  }

  usage() {
    return this.world.usage();
  }

  statMany(paths: readonly string[]) {
    return this.world.statMany(paths);
  }

  children(path: string) {
    return this.world.children(path);
  }

  async commitShell(input: Parameters<WorldSqlStore["commitShell"]>[0]) {
    const result = await this.ctx.blockConcurrencyWhile(() =>
      this.world.commitShell(input),
    );
    if (
      result.status === "committed" &&
      input.entries.some(
        (entry) =>
          entry.path === "stella.app.json" ||
          entry.path.endsWith("/stella.app.json"),
      )
    )
      await this.apps.reconcile();
    return result;
  }

  changesSince(revision: number) {
    return this.world.changesSince(revision);
  }

  exportBlob(sha256: string) {
    return this.world.exportBlob(sha256);
  }

  exportTar(manifestId?: string) {
    return this.world.exportTar(manifestId);
  }

  async alarm(): Promise<void> {
    if (await this.world.collectGarbage(100)) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}
