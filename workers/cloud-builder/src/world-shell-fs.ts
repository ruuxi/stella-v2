/**
 * The worker shell's only way into the world.
 *
 * A BuildSession mints this loopback through `ctx.exports` with props naming
 * one owner world and one fork, and hands it to the shell's Dynamic Worker as
 * its sole binding. The shell cannot choose a different world or fork, cannot
 * reach any other binding, and cannot change the world at all: it may read,
 * list, and upload unreferenced blobs. Committing a run's changes is the
 * BuildSession's decision, made with `WorldStore.commitShell`.
 *
 * Calls land here rather than in the BuildSession, so the bytes a script
 * reads never pass through the agent's Durable Object.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { sha256BytesHex } from "./hash.js";
import type { WorldShellFsRpc } from "./worker-shell/protocol.js";
import { WORKER_SHELL_LIMITS } from "./worker-shell/protocol.js";
import type { WorldEntry } from "./world/types.js";

export type WorldShellFsProps = Readonly<{
  worldName: string;
  /** Absent for the shared world. */
  fork?: string;
}>;

const MAX_STAT_PATHS = 256;

const assertPath = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("World path must be a string.");
  return value;
};

export class WorldShellFs
  extends WorkerEntrypoint<Env, WorldShellFsProps>
  implements WorldShellFsRpc
{
  #world() {
    return this.env.WORLDS.getByName(this.ctx.props.worldName);
  }

  #scope(): { fork?: string } {
    return this.ctx.props.fork ? { fork: this.ctx.props.fork } : {};
  }

  async stat(paths: readonly string[]): Promise<(WorldEntry | null)[]> {
    if (!Array.isArray(paths) || paths.length > MAX_STAT_PATHS) {
      throw new TypeError(`stat takes at most ${MAX_STAT_PATHS} paths.`);
    }
    return await this.#world().statMany(paths.map(assertPath), this.#scope());
  }

  async children(path: string): Promise<WorldEntry[]> {
    return await this.#world().children(assertPath(path), this.#scope());
  }

  async read(
    path: string,
    options: { offset: number; length: number },
  ): Promise<Uint8Array<ArrayBufferLike> | null> {
    const { offset, length } = options;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > WORKER_SHELL_LIMITS.readChunkBytes
    ) {
      throw new RangeError("Invalid world read range.");
    }
    return await this.#world().readFile(assertPath(path), {
      offset,
      length,
      ...this.#scope(),
    });
  }

  async putBlob(bytes: Uint8Array<ArrayBufferLike>): Promise<{ sha256: string; size: number }> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Blob content must be bytes.");
    }
    if (bytes.byteLength > WORKER_SHELL_LIMITS.fileBytes) {
      throw new RangeError("Blob exceeds the worker shell file limit.");
    }
    const sha256 = await sha256BytesHex(bytes);
    const outcome = await this.#world().putBlob(new Blob([bytes]).stream(), {
      sha256,
      size: bytes.byteLength,
    });
    if (!outcome.accepted) throw new Error(outcome.error);
    return { sha256, size: bytes.byteLength };
  }
}
