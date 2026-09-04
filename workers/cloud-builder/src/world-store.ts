import { DurableObject } from "cloudflare:workers";
import { WorldSqlStore } from "./world/store.js";
import type { WorldListingEntry, WorldToolCall } from "./world/types.js";

export class WorldStore extends DurableObject<Env> {
  private readonly world: WorldSqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.world = new WorldSqlStore(ctx.storage.sql, env.WORLDS_BUCKET);
    ctx.blockConcurrencyWhile(async () => this.world.initialize());
  }

  stat(path: string) {
    return this.world.stat(path);
  }

  list(prefix: string, options: { cursor?: string; limit?: number } = {}) {
    return this.world.list(prefix, options);
  }

  readFile(path: string, options: { offset?: number; length?: number } = {}) {
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

  beginBlob() {
    return this.world.beginBlob();
  }

  appendBlob(uploadId: string, bytes: Uint8Array) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.appendBlob(uploadId, bytes),
    );
  }

  finishBlob(
    uploadId: string,
    options: { path?: string; sha256?: string; mode?: number; mtime?: number },
  ) {
    return this.ctx.blockConcurrencyWhile(() =>
      this.world.finishBlob(uploadId, options),
    );
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

  tool(call: WorldToolCall) {
    return call.name === "Read" || call.name === "Grep" || call.name === "glob"
      ? this.world.tool(call)
      : this.ctx.blockConcurrencyWhile(() => this.world.tool(call));
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

  selectContainerSize(initial: "small" | "large") {
    return this.world.selectContainerSize(initial);
  }

  rememberContainerSize(size: "small" | "large") {
    return this.world.rememberContainerSize(size);
  }

  diff(listing: WorldListingEntry[]) {
    return this.world.diff(listing);
  }

  pushDiff(input: { entries: WorldListingEntry[]; deleted: string[] }) {
    return this.ctx.blockConcurrencyWhile(() => this.world.pushDiff(input));
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
