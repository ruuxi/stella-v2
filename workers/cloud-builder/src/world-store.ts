import { DurableObject } from "cloudflare:workers";
import { WorldSqlStore } from "./world/store.js";
import type { WorldListingEntry, WorldToolCall } from "./world/types.js";

export class WorldStore extends DurableObject<Env> {
  private readonly world: WorldSqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.world = new WorldSqlStore(ctx.storage.sql, env.WORLDS_BUCKET);
    void ctx.blockConcurrencyWhile(() => {
      this.world.initialize();
      return Promise.resolve();
    });
  }

  stat(path: string, options: { fork?: string } = {}) {
    return this.world.stat(path, options);
  }

  list(
    prefix: string,
    options: { cursor?: string; limit?: number; fork?: string } = {},
  ) {
    return this.world.list(prefix, options);
  }

  readFile(
    path: string,
    options: { offset?: number; length?: number; fork?: string } = {},
  ) {
    return this.world.readFile(path, options);
  }

  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode?: number; mtime?: number; fork?: string } = {},
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

  mkdir(path: string, options: { mode?: number; fork?: string } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.mkdir(path, options),
    );
  }

  remove(path: string, options: { recursive?: boolean; fork?: string } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.remove(path, options),
    );
  }

  rename(from: string, to: string, options: { fork?: string } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.rename(from, to, options),
    );
  }

  symlink(path: string, target: string, options: { fork?: string } = {}) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.symlink(path, target, options),
    );
  }

  tool(call: WorldToolCall) {
    return call.name === "Read" || call.name === "Grep" || call.name === "glob"
      ? this.world.tool(call)
      : this.ctx.blockConcurrencyWhile(() => this.world.tool(call));
  }

  async checkpoint(options: { historyCursor: string; fork?: string }) {
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

  head(options: { fork?: string } = {}) {
    return this.world.head(options);
  }

  selectContainerSize(initial: "small" | "large") {
    return this.world.selectContainerSize(initial);
  }

  rememberContainerSize(size: "small" | "large") {
    return this.world.rememberContainerSize(size);
  }

  diff(listing: WorldListingEntry[], options: { fork?: string } = {}) {
    return this.world.diff(listing, options);
  }

  pushDiff(input: {
    entries: WorldListingEntry[];
    deleted: string[];
    fork?: string;
  }) {
    return this.ctx.blockConcurrencyWhile(() => this.world.pushDiff(input));
  }

  changesSince(revision: number, options: { fork?: string } = {}) {
    return this.world.changesSince(revision, options);
  }

  exportBlob(sha256: string) {
    return this.world.exportBlob(sha256);
  }

  exportTar(manifestId?: string, options: { fork?: string } = {}) {
    return this.world.exportTar(manifestId, options);
  }

  fork(input: { from?: string; kind: "fork" | "new"; threadId: string }) {
    return this.ctx.blockConcurrencyWhile(() => this.world.fork(input));
  }

  merge(input: { from: string; into?: string; strategy: "last_writer_wins" }) {
    return this.ctx.blockConcurrencyWhile(() => this.world.merge(input));
  }

  forkStatus(forkId: string) {
    return this.world.forkStatus(forkId);
  }

  async dropFork(forkId: string) {
    const result = await this.ctx.blockConcurrencyWhile(() =>
      this.world.dropFork(forkId),
    );
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return result;
  }

  async alarm(): Promise<void> {
    if (await this.world.collectGarbage(100)) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}
