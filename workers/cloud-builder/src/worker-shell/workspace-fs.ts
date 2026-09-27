/**
 * The filesystem the worker shell sees.
 *
 * Under the workspace root it is the owner's world, read live through the
 * scoped loopback and written into an overlay held in this isolate. Nothing
 * reaches the world until the BuildSession commits `changes()`, so every
 * statement of a run that later falls back to the sandbox is simply dropped.
 *
 * Outside the root there is only what the interpreter itself needs: `/dev`
 * (null, process-substitution backing files) and the `/bin` stubs just-bash
 * resolves commands through. Anything else the sandbox would answer from a
 * real system (skills under `/tmp`, the tool home, `/etc`), so touching it
 * vetoes the run instead of reporting a file as missing that is not.
 */

import { InMemoryFs } from "just-bash";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { WorldEntry, WorldListingEntry } from "../world/types.js";
import {
  WORKER_SHELL_LIMITS,
  type WorkerShellChanges,
  type WorkerShellFallbackReason,
  type WorkerShellReadSet,
  type WorkerShellStats,
} from "./protocol.js";
import { normalizeShellPath } from "./paths.js";

/**
 * The world as the shell reads it. The Dynamic Worker's loopback implements
 * this; tests implement it over a map.
 */
export interface WorkerShellWorld {
  stat(paths: readonly string[]): Promise<(WorldEntry | null)[]>;
  children(path: string): Promise<WorldEntry[]>;
  read(
    path: string,
    options: { offset: number; length: number },
  ): Promise<Uint8Array<ArrayBufferLike> | null>;
  putBlob(bytes: Uint8Array<ArrayBufferLike>): Promise<{ sha256: string; size: number }>;
}

export class WorkerShellVetoError extends Error {
  constructor(
    readonly reason: WorkerShellFallbackReason,
    readonly detail: string,
  ) {
    super(`The lightweight shell cannot run this: ${detail}`);
    this.name = "WorkerShellVetoError";
  }
}

/**
 * One run's refusal. The first veto wins; every later filesystem call and
 * dispatch hook fails immediately, so the interpreter unwinds at its next
 * touch of anything outside its own memory, and the run's deadline bounds a
 * script that never touches anything again.
 */
export class WorkerShellGuard {
  #veto: WorkerShellVetoError | null = null;

  vetoed(): WorkerShellVetoError | null {
    return this.#veto;
  }

  /** Record a refusal without throwing, for callbacks that must not throw. */
  stop(reason: WorkerShellFallbackReason, detail: string): void {
    this.#veto ??= new WorkerShellVetoError(reason, detail);
  }

  veto(reason: WorkerShellFallbackReason, detail: string): never {
    this.stop(reason, detail);
    throw this.#veto!;
  }

  check(): void {
    if (this.#veto) throw this.#veto;
  }
}

type FileContentRef =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  /** An unchanged world blob, still readable at its original path. */
  | Readonly<{ kind: "world"; path: string; sha256: string; size: number }>;

type OverlayNode =
  | {
      kind: "file";
      mode: number;
      mtime: number;
      content: FileContentRef;
      replacesWorld: boolean;
    }
  | { kind: "dir"; mode: number; mtime: number; replacesWorld: boolean }
  | {
      kind: "symlink";
      mode: number;
      mtime: number;
      target: string;
      replacesWorld: boolean;
    };

/** A node as a lookup sees it, whichever side it came from. */
type Node =
  | Readonly<{
      kind: "file";
      mode: number;
      mtime: number;
      size: number;
      content: FileContentRef;
    }>
  | Readonly<{ kind: "dir"; mode: number; mtime: number }>
  | Readonly<{ kind: "symlink"; mode: number; mtime: number; target: string }>;

// just-bash's IFileSystem takes these but does not export them.
type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };
type DirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

const MAX_SYMLINK_HOPS = 40;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const SYMLINK_MODE = 0o777;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export { normalizeShellPath };

const joinShell = (parent: string, name: string): string =>
  parent === "/" ? `/${name}` : `${parent}/${name}`;

const joinWorld = (parent: string, name: string): string =>
  parent === "" ? name : `${parent}/${name}`;

const worldParent = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

const worldBase = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
};

const within = (path: string, prefix: string): boolean =>
  prefix === "" || path === prefix || path.startsWith(`${prefix}/`);

const fsError = (
  code: string,
  message: string,
  operation: string,
  path: string,
): Error => {
  const error = new Error(`${code}: ${message}, ${operation} '${path}'`);
  (error as Error & { code: string }).code = code;
  return error;
};

const encodingOf = (
  options: ReadFileOptions | WriteFileOptions | BufferEncoding | null | undefined,
): BufferEncoding | undefined =>
  typeof options === "string"
    ? options
    : ((options?.encoding ?? undefined) as BufferEncoding | undefined);

const toBytes = (content: FileContent, encoding?: BufferEncoding): Uint8Array => {
  if (content instanceof Uint8Array) return content;
  if (encoding === "binary" || encoding === "latin1") {
    const bytes = new Uint8Array(content.length);
    for (let index = 0; index < content.length; index += 1) {
      bytes[index] = content.charCodeAt(index) & 0xff;
    }
    return bytes;
  }
  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (character) =>
      character.charCodeAt(0),
    );
  }
  if (encoding === "hex") {
    const bytes = new Uint8Array(Math.floor(content.length / 2));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(content.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  return textEncoder.encode(content);
};

const fromBytes = (bytes: Uint8Array, encoding?: BufferEncoding | null): string => {
  if (encoding === "binary" || encoding === "latin1") {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return text;
  }
  if (encoding === "base64") {
    return btoa(fromBytes(bytes, "binary"));
  }
  if (encoding === "hex") {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  if (encoding === "ascii") {
    return fromBytes(bytes.map((byte) => byte & 0x7f), "binary");
  }
  return textDecoder.decode(bytes);
};

const stat = (node: Node): FsStat => ({
  isFile: node.kind === "file",
  isDirectory: node.kind === "dir",
  isSymbolicLink: node.kind === "symlink",
  mode: node.mode,
  size:
    node.kind === "file"
      ? node.size
      : node.kind === "symlink"
        ? textEncoder.encode(node.target).byteLength
        : 0,
  mtime: new Date(node.mtime),
});

const fromWorld = (entry: WorldEntry, path: string): Node => {
  if (entry.kind === "dir") {
    return { kind: "dir", mode: entry.mode, mtime: entry.mtime };
  }
  if (entry.kind === "symlink") {
    return {
      kind: "symlink",
      mode: entry.mode,
      mtime: entry.mtime,
      target: entry.target ?? "",
    };
  }
  return {
    kind: "file",
    mode: entry.mode,
    mtime: entry.mtime,
    size: entry.size,
    content: {
      kind: "world",
      path,
      sha256: entry.sha256 ?? "",
      size: entry.size,
    },
  };
};

const fromOverlay = (node: OverlayNode): Node => {
  if (node.kind === "file") {
    return {
      kind: "file",
      mode: node.mode,
      mtime: node.mtime,
      size:
        node.content.kind === "bytes"
          ? node.content.bytes.byteLength
          : node.content.size,
      content: node.content,
    };
  }
  if (node.kind === "dir") {
    return { kind: "dir", mode: node.mode, mtime: node.mtime };
  }
  return {
    kind: "symlink",
    mode: node.mode,
    mtime: node.mtime,
    target: node.target,
  };
};

/**
 * Paths outside the root the interpreter may use. `/dev` is private scratch;
 * the command stubs may only be probed, never listed or read, because a
 * script that inspects `/usr/bin` is asking about a system this is not.
 */
const SCRATCH_ROOT = "/dev";
const STUB_DIRECTORIES: ReadonlySet<string> = new Set(["/bin", "/usr/bin"]);

type Resolved =
  | Readonly<{ kind: "world"; path: string; node: Node | null }>
  | Readonly<{ kind: "system"; path: string }>;

export type WorkerShellFileSystemOptions = Readonly<{
  /** Absolute shell path of the workspace root. */
  root: string;
  world: WorkerShellWorld;
  guard: WorkerShellGuard;
  now?: () => number;
  limits?: Partial<typeof WORKER_SHELL_LIMITS>;
  /** World-relative subtrees whose touch vetoes the run. */
  sandboxOnly?: readonly string[];
}>;

export class WorkerShellFileSystem implements IFileSystem {
  readonly #root: string;
  readonly #world: WorkerShellWorld;
  readonly #guard: WorkerShellGuard;
  readonly #now: () => number;
  readonly #limits: typeof WORKER_SHELL_LIMITS;
  readonly #sandboxOnly: readonly string[];
  /** just-bash's own layout: /bin stubs, /dev, /proc. Never the world. */
  readonly #system = new InMemoryFs(undefined, {
    maxTotalBytes: WORKER_SHELL_LIMITS.scratchBytes,
  });
  /** World entries by path, as first read this run. `null` is a miss. */
  readonly #worldCache = new Map<string, WorldEntry | null>();
  readonly #childrenCache = new Map<string, WorldEntry[]>();
  /** This run's writes. `null` deletes the world's entry and all below it. */
  readonly #overlay = new Map<string, OverlayNode | null>();
  readonly #overlayChildren = new Map<string, Set<string>>();
  readonly #readPaths = new Set<string>();
  readonly #readChildren = new Set<string>();
  #worldCalls = 0;
  #bytesRead = 0;
  #bytesStaged = 0;

  constructor(options: WorkerShellFileSystemOptions) {
    this.#root = normalizeShellPath(options.root);
    if (this.#root === "/") throw new Error("The workspace root cannot be /.");
    this.#world = options.world;
    this.#guard = options.guard;
    this.#now = options.now ?? (() => Date.now());
    this.#limits = { ...WORKER_SHELL_LIMITS, ...options.limits };
    this.#sandboxOnly = options.sandboxOnly ?? [];
  }

  // --- just-bash layout initialization ------------------------------------
  // `initFilesystem` and command registration write their stubs with these;
  // they land in the private system tree and never touch the world.

  mkdirSync(path: string, options?: MkdirOptions): void {
    if (this.#worldRelative(normalizeShellPath(path)) !== null) return;
    this.#system.mkdirSync(path, options);
  }

  writeFileSync(path: string, content: FileContent): void {
    if (this.#worldRelative(normalizeShellPath(path)) !== null) return;
    this.#system.writeFileSync(path, content);
  }

  // --- accounting -----------------------------------------------------------

  readSet(): WorkerShellReadSet {
    return {
      paths: [...this.#readPaths].sort(),
      children: [...this.#readChildren].sort(),
    };
  }

  stats(): WorkerShellStats {
    return {
      worldCalls: this.#worldCalls,
      bytesRead: this.#bytesRead,
      bytesStaged: this.#bytesStaged,
    };
  }

  #spendCall(): void {
    this.#guard.check();
    this.#worldCalls += 1;
    if (this.#worldCalls > this.#limits.worldCalls) {
      this.#guard.veto(
        "resource_limit",
        `the command touches more than ${this.#limits.worldCalls} workspace entries`,
      );
    }
  }

  // --- path classification --------------------------------------------------

  #worldRelative(path: string): string | null {
    if (path === this.#root) return "";
    if (path.startsWith(`${this.#root}/`)) {
      return path.slice(this.#root.length + 1);
    }
    return null;
  }

  #isRootAncestor(path: string): boolean {
    return path === "/" || this.#root.startsWith(`${path}/`);
  }

  #isScratch(path: string): boolean {
    return path === SCRATCH_ROOT || path.startsWith(`${SCRATCH_ROOT}/`);
  }

  /**
   * Directories a path walk may pass through on its way to the workspace or
   * to the command stubs. They exist; their contents are not the shell's.
   */
  #isSystemDirectory(path: string): boolean {
    return (
      this.#isRootAncestor(path) ||
      STUB_DIRECTORIES.has(path) ||
      path === "/usr"
    );
  }

  #isStub(path: string): boolean {
    const slash = path.lastIndexOf("/");
    return STUB_DIRECTORIES.has(path.slice(0, slash));
  }

  #outside(path: string, operation: string): never {
    this.#guard.veto(
      "outside_workspace",
      `${operation} ${path} is outside the workspace ${this.#root}`,
    );
  }

  // --- world reads -----------------------------------------------------------

  async #worldEntries(paths: readonly string[]): Promise<void> {
    const missing = [...new Set(paths)].filter(
      (path) => !this.#worldCache.has(path),
    );
    if (missing.length === 0) return;
    this.#spendCall();
    const entries = await this.#world.stat(missing);
    this.#guard.check();
    missing.forEach((path, index) => {
      this.#worldCache.set(path, entries[index] ?? null);
    });
  }

  /**
   * The node at one exact world path, not following a symlink at that path.
   * Ancestors are not resolved here; `#resolve` walks them.
   */
  async #nodeAt(path: string): Promise<Node | null> {
    // The overlay decides first: a deletion or a replaced directory hides
    // everything the world has below it.
    const segments = path === "" ? [] : path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (!this.#overlay.has(ancestor)) continue;
      const node = this.#overlay.get(ancestor);
      if (node === null || node?.kind !== "dir") return null;
    }
    if (this.#overlay.has(path)) {
      const node = this.#overlay.get(path);
      return node ? fromOverlay(node) : null;
    }
    if (this.#hiddenByOverlay(path)) return null;
    if (path === "") {
      return { kind: "dir", mode: DEFAULT_DIR_MODE, mtime: 0 };
    }
    this.#readPaths.add(path);
    await this.#worldEntries([path]);
    const entry = this.#worldCache.get(path) ?? null;
    return entry ? fromWorld(entry, path) : null;
  }

  /** Whether an overlay directory that replaced the world's hides `path`. */
  #hiddenByOverlay(path: string): boolean {
    let current = path;
    while (current !== "") {
      current = worldParent(current);
      const node = this.#overlay.get(current);
      if (node === null) return true;
      if (node && node.replacesWorld) return true;
    }
    return false;
  }

  /**
   * Walk a shell path to a world node, following symlinks in every ancestor
   * and, when asked, in the last component. A link that leaves the root can
   * only be followed by a real system, so it vetoes the run.
   */
  async #resolve(
    shellPath: string,
    operation: string,
    follow: boolean,
  ): Promise<Resolved> {
    this.#guard.check();
    let path = normalizeShellPath(shellPath);
    for (let hops = 0; ; ) {
      const relative = this.#worldRelative(path);
      if (relative === null) return { kind: "system", path };
      const reserved = this.#sandboxOnly.find(
        (prefix) => relative !== "" && within(relative, prefix),
      );
      if (reserved !== undefined) {
        this.#guard.veto(
          "sandbox_only_path",
          `${joinShell(this.#root, reserved)} is synchronized when the sandbox starts`,
        );
      }
      const segments = relative === "" ? [] : relative.split("/");
      // One round trip for every prefix this walk may need.
      const prefixes = segments.map((_, index) =>
        segments.slice(0, index + 1).join("/"),
      );
      const unknown = prefixes.filter(
        (prefix) => !this.#overlay.has(prefix) && !this.#hiddenByOverlay(prefix),
      );
      for (const prefix of unknown) this.#readPaths.add(prefix);
      await this.#worldEntries(unknown);
      let current = "";
      let redirected: string | null = null;
      for (const [index, segment] of segments.entries()) {
        const next = joinWorld(current, segment);
        const node = await this.#nodeAt(next);
        const last = index === segments.length - 1;
        if (!node) {
          return last
            ? { kind: "world", path: next, node: null }
            : { kind: "world", path: joinWorld(next, segments.slice(index + 1).join("/")), node: null };
        }
        if (node.kind === "symlink" && (!last || follow)) {
          hops += 1;
          if (hops > MAX_SYMLINK_HOPS) {
            throw fsError(
              "ELOOP",
              "too many levels of symbolic links",
              operation,
              shellPath,
            );
          }
          const base = joinShell(this.#root, current).replace(/\/$/u, "");
          const target = node.target.startsWith("/")
            ? node.target
            : `${current === "" ? this.#root : base}/${node.target}`;
          const rest = segments.slice(index + 1).join("/");
          redirected = normalizeShellPath(rest ? `${target}/${rest}` : target);
          if (this.#worldRelative(redirected) === null) {
            this.#guard.veto(
              "outside_workspace",
              `${shellPath} is a link to ${node.target}, outside the workspace`,
            );
          }
          break;
        }
        if (!last && node.kind !== "dir") {
          throw fsError("ENOTDIR", "not a directory", operation, shellPath);
        }
        if (last) return { kind: "world", path: next, node };
        current = next;
      }
      if (redirected === null) {
        return {
          kind: "world",
          path: "",
          node: { kind: "dir", mode: DEFAULT_DIR_MODE, mtime: 0 },
        };
      }
      path = redirected;
    }
  }

  async #bytes(node: Extract<Node, { kind: "file" }>, shellPath: string) {
    if (node.content.kind === "bytes") return node.content.bytes;
    const { path, size } = node.content;
    if (size > this.#limits.fileBytes) {
      this.#guard.veto(
        "resource_limit",
        `${shellPath} is ${size} bytes; the lightweight shell reads files up to ${this.#limits.fileBytes} bytes`,
      );
    }
    if (this.#bytesRead + size > this.#limits.totalReadBytes) {
      this.#guard.veto(
        "resource_limit",
        `the command reads more than ${this.#limits.totalReadBytes} bytes of the workspace`,
      );
    }
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; ) {
      this.#spendCall();
      const length = Math.min(this.#limits.readChunkBytes, size - offset);
      const chunk = await this.#world.read(path, { offset, length });
      this.#guard.check();
      if (!chunk || (chunk.byteLength === 0 && length > 0)) {
        // The file changed after this run looked it up. Reading on would mix
        // two versions; the commit check would refuse it anyway.
        throw fsError(
          "EIO",
          "file changed while it was being read",
          "read",
          shellPath,
        );
      }
      bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, size - offset)), offset);
      offset += chunk.byteLength;
    }
    this.#bytesRead += size;
    return bytes;
  }

  async #children(path: string, shellPath: string): Promise<Map<string, Node>> {
    const result = new Map<string, Node>();
    const replaced = this.#overlay.get(path)?.replacesWorld === true;
    if (!replaced && !this.#hiddenByOverlay(path)) {
      let entries = this.#childrenCache.get(path);
      if (!entries) {
        this.#spendCall();
        this.#readChildren.add(path);
        entries = await this.#world.children(path);
        this.#guard.check();
        if (entries.length > this.#limits.worldCalls) {
          this.#guard.veto(
            "resource_limit",
            `${shellPath} has more than ${this.#limits.worldCalls} entries`,
          );
        }
        this.#childrenCache.set(path, entries);
        for (const entry of entries) {
          if (!this.#worldCache.has(entry.path)) {
            this.#worldCache.set(entry.path, entry);
          }
        }
      }
      for (const entry of entries) {
        if (this.#overlay.has(entry.path)) continue;
        result.set(worldBase(entry.path), fromWorld(entry, entry.path));
      }
    }
    for (const name of this.#overlayChildren.get(path) ?? []) {
      const node = this.#overlay.get(joinWorld(path, name));
      if (node) result.set(name, fromOverlay(node));
      else result.delete(name);
    }
    return result;
  }

  // --- world writes ----------------------------------------------------------

  /** Drop the staged bytes an overlay entry holds, before it is replaced. */
  #release(path: string): void {
    const previous = this.#overlay.get(path);
    if (previous?.kind === "file" && previous.content.kind === "bytes") {
      this.#bytesStaged -= previous.content.bytes.byteLength;
    }
  }

  #setOverlay(path: string, node: OverlayNode | null): void {
    this.#guard.check();
    this.#release(path);
    if (node === null) {
      // A deletion covers everything the overlay created below it too.
      for (const key of [...this.#overlay.keys()]) {
        if (key === path || !within(key, path)) continue;
        this.#release(key);
        this.#overlay.delete(key);
        this.#overlayChildren.get(worldParent(key))?.delete(worldBase(key));
      }
    } else if (node.kind === "file" && node.content.kind === "bytes") {
      this.#bytesStaged += node.content.bytes.byteLength;
      if (this.#bytesStaged > this.#limits.stagedBytes) {
        this.#guard.veto(
          "resource_limit",
          `the command writes more than ${this.#limits.stagedBytes} bytes`,
        );
      }
    }
    this.#overlay.set(path, node);
    if (this.#overlay.size > this.#limits.stagedFiles) {
      this.#guard.veto(
        "resource_limit",
        `the command changes more than ${this.#limits.stagedFiles} workspace entries`,
      );
    }
    if (path === "") return;
    const parent = worldParent(path);
    let siblings = this.#overlayChildren.get(parent);
    if (!siblings) {
      siblings = new Set();
      this.#overlayChildren.set(parent, siblings);
    }
    siblings.add(worldBase(path));
  }

  /** Whether creating at `path` replaces something the world still has. */
  #replacesWorld(path: string): boolean {
    return this.#overlay.get(path) === null;
  }

  async #writableParent(
    shellPath: string,
    operation: string,
  ): Promise<{ parent: string; name: string }> {
    const normalized = normalizeShellPath(shellPath);
    const slash = normalized.lastIndexOf("/");
    const parentShell = normalized.slice(0, slash) || "/";
    const name = normalized.slice(slash + 1);
    const parent = await this.#resolve(parentShell, operation, true);
    if (parent.kind === "system") this.#outside(normalized, operation);
    if (!parent.node) {
      throw fsError("ENOENT", "no such file or directory", operation, shellPath);
    }
    if (parent.node.kind !== "dir") {
      throw fsError("ENOTDIR", "not a directory", operation, shellPath);
    }
    return { parent: parent.path, name };
  }

  async #writeWorld(
    shellPath: string,
    bytes: Uint8Array,
    operation: string,
  ): Promise<void> {
    if (bytes.byteLength > this.#limits.fileBytes) {
      this.#guard.veto(
        "resource_limit",
        `${shellPath} would be ${bytes.byteLength} bytes; the lightweight shell writes files up to ${this.#limits.fileBytes} bytes`,
      );
    }
    const target = await this.#resolve(shellPath, operation, true);
    if (target.kind === "system") this.#outside(target.path, operation);
    if (target.node?.kind === "dir") {
      throw fsError("EISDIR", "illegal operation on a directory", operation, shellPath);
    }
    let path = target.path;
    if (!target.node) {
      // A link may point at a file that does not exist yet; the write lands
      // at the link's target, which must itself sit in an existing directory.
      const location = await this.#writableParent(
        joinShell(this.#root, path),
        operation,
      );
      path = joinWorld(location.parent, location.name);
    }
    this.#setOverlay(path, {
      kind: "file",
      mode: target.node?.mode ?? DEFAULT_FILE_MODE,
      mtime: this.#now(),
      content: { kind: "bytes", bytes },
      replacesWorld: this.#replacesWorld(path),
    });
  }

  // --- IFileSystem: reads ----------------------------------------------------

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    return fromBytes(await this.readFileBuffer(path), encodingOf(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resolved = await this.#resolve(path, "open", true);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path)) {
        return await this.#system.readFileBuffer(resolved.path);
      }
      this.#outside(resolved.path, "reading");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", "open", path);
    }
    if (resolved.node.kind !== "file") {
      throw fsError("EISDIR", "illegal operation on a directory", "read", path);
    }
    return await this.#bytes(resolved.node, path);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeShellPath(path);
    const resolved = await this.#resolve(normalized, "access", true);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path) || this.#isStub(resolved.path)) {
        return await this.#system.exists(resolved.path);
      }
      if (this.#isSystemDirectory(resolved.path)) return true;
      this.#outside(resolved.path, "checking");
    }
    return resolved.node !== null;
  }

  async stat(path: string): Promise<FsStat> {
    return await this.#statPath(path, true, "stat");
  }

  async lstat(path: string): Promise<FsStat> {
    return await this.#statPath(path, false, "lstat");
  }

  async #statPath(
    path: string,
    follow: boolean,
    operation: string,
  ): Promise<FsStat> {
    const resolved = await this.#resolve(path, operation, follow);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path) || this.#isStub(resolved.path)) {
        return follow
          ? await this.#system.stat(resolved.path)
          : await this.#system.lstat(resolved.path);
      }
      if (this.#isSystemDirectory(resolved.path)) {
        return stat({ kind: "dir", mode: DEFAULT_DIR_MODE, mtime: 0 });
      }
      this.#outside(resolved.path, "inspecting");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", operation, path);
    }
    return stat(resolved.node);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const resolved = await this.#resolve(path, "scandir", true);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path)) {
        return await this.#system.readdirWithFileTypes(resolved.path);
      }
      this.#outside(resolved.path, "listing");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", "scandir", path);
    }
    if (resolved.node.kind !== "dir") {
      throw fsError("ENOTDIR", "not a directory", "scandir", path);
    }
    const children = await this.#children(resolved.path, path);
    return [...children.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, node]) => ({
        name,
        isFile: node.kind === "file",
        isDirectory: node.kind === "dir",
        isSymbolicLink: node.kind === "symlink",
      }));
  }

  async readlink(path: string): Promise<string> {
    const resolved = await this.#resolve(path, "readlink", false);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path)) {
        return await this.#system.readlink(resolved.path);
      }
      this.#outside(resolved.path, "reading the link");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", "readlink", path);
    }
    if (resolved.node.kind !== "symlink") {
      throw fsError("EINVAL", "invalid argument", "readlink", path);
    }
    return resolved.node.target;
  }

  async realpath(path: string): Promise<string> {
    const resolved = await this.#resolve(path, "realpath", true);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path) || this.#isRootAncestor(resolved.path)) {
        return resolved.path;
      }
      this.#outside(resolved.path, "resolving");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", "realpath", path);
    }
    return resolved.path === ""
      ? this.#root
      : joinShell(this.#root, resolved.path);
  }

  resolvePath(base: string, path: string): string {
    return normalizeShellPath(path.startsWith("/") ? path : `${base}/${path}`);
  }

  getAllPaths(): string[] {
    // Globs are expanded by listing directories; nothing here may enumerate
    // the world wholesale.
    return [];
  }

  // --- IFileSystem: writes ---------------------------------------------------

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizeShellPath(path);
    if (this.#worldRelative(normalized) === null) {
      if (this.#isScratch(normalized)) {
        return await this.#system.writeFile(normalized, content, options);
      }
      this.#outside(normalized, "writing");
    }
    await this.#writeWorld(normalized, toBytes(content, encodingOf(options)), "open");
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizeShellPath(path);
    if (this.#worldRelative(normalized) === null) {
      if (this.#isScratch(normalized)) {
        return await this.#system.appendFile(normalized, content, options);
      }
      this.#outside(normalized, "writing");
    }
    const addition = toBytes(content, encodingOf(options));
    let existing: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const resolved = await this.#resolve(normalized, "open", true);
    if (resolved.kind === "world" && resolved.node) {
      if (resolved.node.kind !== "file") {
        throw fsError("EISDIR", "illegal operation on a directory", "write", path);
      }
      existing = await this.#bytes(resolved.node, path);
    }
    const combined = new Uint8Array(existing.byteLength + addition.byteLength);
    combined.set(existing);
    combined.set(addition, existing.byteLength);
    await this.#writeWorld(normalized, combined, "open");
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizeShellPath(path);
    if (this.#worldRelative(normalized) === null) {
      if (this.#isScratch(normalized)) {
        return await this.#system.mkdir(normalized, options);
      }
      if (options?.recursive && this.#isRootAncestor(normalized)) return;
      this.#outside(normalized, "creating");
    }
    const existing = await this.#resolve(normalized, "mkdir", true);
    if (existing.kind === "world" && existing.node) {
      if (existing.node.kind !== "dir") {
        throw fsError("EEXIST", "file already exists", "mkdir", path);
      }
      if (!options?.recursive) {
        throw fsError("EEXIST", "directory already exists", "mkdir", path);
      }
      return;
    }
    const slash = normalized.lastIndexOf("/");
    const parentShell = normalized.slice(0, slash) || "/";
    if (options?.recursive) {
      await this.mkdir(parentShell, { recursive: true });
    }
    const { parent, name } = await this.#writableParent(normalized, "mkdir");
    const worldPath = joinWorld(parent, name);
    this.#setOverlay(worldPath, {
      kind: "dir",
      mode: DEFAULT_DIR_MODE,
      mtime: this.#now(),
      replacesWorld: this.#replacesWorld(worldPath),
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizeShellPath(path);
    if (this.#worldRelative(normalized) === null) {
      if (this.#isScratch(normalized)) {
        return await this.#system.rm(normalized, options);
      }
      this.#outside(normalized, "removing");
    }
    const resolved = await this.#resolve(normalized, "rm", false);
    if (resolved.kind === "system") this.#outside(resolved.path, "removing");
    if (!resolved.node) {
      if (options?.force) return;
      throw fsError("ENOENT", "no such file or directory", "rm", path);
    }
    if (resolved.path === "") {
      this.#guard.veto(
        "unsupported_filesystem_operation",
        "removing the workspace root",
      );
    }
    if (resolved.node.kind === "dir" && !options?.recursive) {
      const children = await this.#children(resolved.path, path);
      if (children.size > 0) {
        throw fsError("ENOTEMPTY", "directory not empty", "rm", path);
      }
    }
    this.#setOverlay(resolved.path, null);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const source = await this.#resolve(src, "cp", false);
    if (source.kind === "system") this.#outside(source.path, "copying");
    if (!source.node) {
      throw fsError("ENOENT", "no such file or directory", "cp", src);
    }
    const destination = normalizeShellPath(dest);
    if (this.#worldRelative(destination) === null) {
      this.#outside(destination, "copying");
    }
    if (source.node.kind === "dir") {
      if (!options?.recursive) {
        throw fsError("EISDIR", "is a directory", "cp", src);
      }
      const destRelative = this.#worldRelative(destination)!;
      if (within(destRelative, source.path)) {
        throw fsError("EINVAL", `cannot copy '${src}' into itself`, "cp", dest);
      }
      await this.mkdir(destination, { recursive: true });
      for (const name of (await this.#children(source.path, src)).keys()) {
        await this.cp(
          joinShell(normalizeShellPath(src), name),
          joinShell(destination, name),
          options,
        );
      }
      return;
    }
    await this.#place(source.node, destination, "cp");
  }

  /**
   * Put a copy of a node at `dest`. File contents that come from the world
   * are copied by reference, so moving a large file costs no bytes here.
   */
  async #place(
    node: Node,
    dest: string,
    operation: "cp" | "mv",
  ): Promise<void> {
    // A copy writes through a link at its destination, as cp(1) does; a move
    // renames onto the link itself, as rename(2) does.
    const existing = await this.#resolve(dest, operation, operation === "cp");
    if (existing.kind === "system") this.#outside(existing.path, operation);
    if (existing.node?.kind === "dir") {
      throw fsError("EISDIR", "illegal operation on a directory", operation, dest);
    }
    const location = existing.node
      ? {
          parent: worldParent(existing.path),
          name: worldBase(existing.path),
        }
      : await this.#writableParent(dest, operation);
    const path = joinWorld(location.parent, location.name);
    const replacesWorld = this.#replacesWorld(path);
    if (node.kind === "file") {
      this.#setOverlay(path, {
        kind: "file",
        mode: node.mode,
        mtime: this.#now(),
        content:
          node.content.kind === "bytes"
            ? { kind: "bytes", bytes: new Uint8Array(node.content.bytes) }
            : node.content,
        replacesWorld,
      });
    } else if (node.kind === "symlink") {
      this.#setOverlay(path, {
        kind: "symlink",
        mode: SYMLINK_MODE,
        mtime: this.#now(),
        target: node.target,
        replacesWorld,
      });
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const source = await this.#resolve(src, "mv", false);
    if (source.kind === "system") this.#outside(source.path, "moving");
    if (!source.node) {
      throw fsError("ENOENT", "no such file or directory", "mv", src);
    }
    const destination = normalizeShellPath(dest);
    const destRelative = this.#worldRelative(destination);
    if (destRelative === null) this.#outside(destination, "moving");
    if (source.path === destRelative) return;
    if (source.path === "") {
      this.#guard.veto(
        "unsupported_filesystem_operation",
        "moving the workspace root",
      );
    }
    if (source.node.kind === "dir") {
      if (within(destRelative!, source.path)) {
        throw fsError("EINVAL", `cannot move '${src}' into itself`, "mv", dest);
      }
      const existing = await this.#resolve(destination, "mv", false);
      if (existing.kind === "world" && existing.node) {
        if (existing.node.kind !== "dir") {
          throw fsError("ENOTDIR", "not a directory", "mv", dest);
        }
        if ((await this.#children(existing.path, dest)).size > 0) {
          throw fsError("ENOTEMPTY", "directory not empty", "mv", dest);
        }
      }
      await this.mkdir(destination, { recursive: true });
      for (const name of (await this.#children(source.path, src)).keys()) {
        await this.mv(
          joinShell(normalizeShellPath(src), name),
          joinShell(destination, name),
        );
      }
      this.#setOverlay(source.path, null);
      return;
    }
    await this.#place(source.node, destination, "mv");
    this.#setOverlay(source.path, null);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.#touch(path, "chmod", (node) => ({ ...node, mode }));
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    await this.#touch(path, "utimes", (node) => ({
      ...node,
      mtime: mtime.getTime(),
    }));
  }

  async #touch(
    path: string,
    operation: string,
    update: (node: OverlayNode) => OverlayNode,
  ): Promise<void> {
    const resolved = await this.#resolve(path, operation, true);
    if (resolved.kind === "system") {
      if (this.#isScratch(resolved.path)) return;
      this.#outside(resolved.path, "changing");
    }
    if (!resolved.node) {
      throw fsError("ENOENT", "no such file or directory", operation, path);
    }
    if (resolved.path === "") {
      this.#guard.veto(
        "unsupported_filesystem_operation",
        `${operation} on the workspace root`,
      );
    }
    const current = this.#overlay.get(resolved.path);
    const found = resolved.node;
    const node: OverlayNode =
      current ??
      (found.kind === "file"
        ? {
            kind: "file",
            mode: found.mode,
            mtime: found.mtime,
            content: found.content,
            replacesWorld: false,
          }
        : found.kind === "dir"
          ? {
              kind: "dir",
              mode: found.mode,
              mtime: found.mtime,
              replacesWorld: false,
            }
          : {
              kind: "symlink",
              mode: found.mode,
              mtime: found.mtime,
              target: found.target,
              replacesWorld: false,
            });
    this.#setOverlay(resolved.path, update(node));
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = normalizeShellPath(linkPath);
    if (this.#worldRelative(normalized) === null) {
      this.#outside(normalized, "linking");
    }
    const existing = await this.#resolve(normalized, "symlink", false);
    if (existing.kind === "world" && existing.node) {
      throw fsError("EEXIST", "file already exists", "symlink", linkPath);
    }
    const { parent, name } = await this.#writableParent(normalized, "symlink");
    const path = joinWorld(parent, name);
    this.#setOverlay(path, {
      kind: "symlink",
      mode: SYMLINK_MODE,
      mtime: this.#now(),
      target,
      replacesWorld: this.#replacesWorld(path),
    });
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    this.#guard.veto(
      "unsupported_filesystem_operation",
      `hard link ${newPath}: the workspace stores no hard links`,
    );
  }

  // --- commit ----------------------------------------------------------------

  /**
   * The run's net effect on the world. New contents are uploaded as blobs
   * first; the entries only reference them, and nothing is visible until the
   * BuildSession commits.
   */
  async changes(): Promise<WorkerShellChanges> {
    this.#guard.check();
    const entries: WorldListingEntry[] = [];
    const deleted: string[] = [];
    for (const [path, node] of this.#overlay) {
      if (node === null) {
        deleted.push(path);
        continue;
      }
      if (node.replacesWorld) deleted.push(path);
      if (node.kind === "dir") {
        entries.push({ path, kind: "dir", mode: node.mode, mtime: node.mtime, size: 0 });
      } else if (node.kind === "symlink") {
        entries.push({
          path,
          kind: "symlink",
          mode: node.mode,
          mtime: node.mtime,
          size: textEncoder.encode(node.target).byteLength,
          target: node.target,
        });
      } else if (node.content.kind === "world") {
        // The source must still be the blob this run read when it commits.
        this.#readPaths.add(node.content.path);
        entries.push({
          path,
          kind: "file",
          mode: node.mode,
          mtime: node.mtime,
          size: node.content.size,
          sha256: node.content.sha256,
        });
      } else {
        this.#spendCall();
        const blob = await this.#world.putBlob(node.content.bytes);
        this.#guard.check();
        entries.push({
          path,
          kind: "file",
          mode: node.mode,
          mtime: node.mtime,
          size: blob.size,
          sha256: blob.sha256,
        });
      }
    }
    return { entries, deleted: [...new Set(deleted)] };
  }
}
