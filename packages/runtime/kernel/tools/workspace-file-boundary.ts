/**
 * Symlink-safe file operations for a model-scoped workspace.
 *
 * Cloud tools run in the trusted executor process, while shell commands run
 * as an unprivileged account. A lexical `path.relative` check is therefore
 * insufficient: the shell can place a symlink inside the workspace and ask a
 * root in-process file tool to follow it into private executor state.
 *
 * Linux (the cloud runtime) walks from an opened workspace directory through
 * `/proc/self/fd`, opening every parent with O_DIRECTORY | O_NOFOLLOW. This is
 * an openat-style anchored traversal using Node's available primitives. Other
 * platforms use a conservative component walk plus opened-inode rechecks;
 * they reject the same aliases, though Node does not expose openat2 there.
 */

import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const PROC_FD_ROOT = "/proc/self/fd";

type OpenedWorkspaceFile = {
  displayPath: string;
  entryPath: string;
  handle: FileHandle;
  parentHandles: FileHandle[];
};

type BoundaryHooks = {
  /** Test-only race injection after the final descriptor is open. */
  afterOpen?: () => void | Promise<void>;
};

type WorkspaceFileOwner = { uid: number; gid: number };
export type WorkspaceFileIdentity = Pick<
  Awaited<ReturnType<FileHandle["stat"]>>,
  "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs"
>;

const isInside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const relativeTarget = (
  filePath: string,
  workspaceRoot: string,
): { lexicalRoot: string; relative: string } => {
  const lexicalRoot = path.resolve(workspaceRoot);
  const target = path.resolve(filePath);
  if (!isInside(target, lexicalRoot)) {
    throw new Error("Path is outside the shared session workspace.");
  }
  const relative = path.relative(lexicalRoot, target);
  if (
    !relative ||
    relative.split(path.sep).some((part) => !part || part === "..")
  ) {
    throw new Error("A workspace file path must name a file below the root.");
  }
  return { lexicalRoot, relative };
};

const closeAll = async (handles: FileHandle[]): Promise<void> => {
  await Promise.allSettled(
    handles.reverse().map(async (handle) => handle.close()),
  );
};

const ownedBy = (
  metadata: { uid: number; gid: number },
  owner: WorkspaceFileOwner | undefined,
): boolean =>
  !owner || (metadata.uid === owner.uid && metadata.gid === owner.gid);

const assertDirectory = async (
  handle: FileHandle,
  owner?: WorkspaceFileOwner,
): Promise<void> => {
  const metadata = await handle.stat();
  if (!metadata.isDirectory() || !ownedBy(metadata, owner)) {
    throw new Error(
      "Workspace path contains a non-directory or foreign-owned parent.",
    );
  }
};

const openLinuxParent = async (args: {
  canonicalRoot: string;
  parentParts: string[];
  createParents: boolean;
  owner?: WorkspaceFileOwner;
}): Promise<{ entryParent: string; handles: FileHandle[] }> => {
  const handles: FileHandle[] = [];
  try {
    let current = await open(
      args.canonicalRoot,
      fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW,
    );
    handles.push(current);
    await assertDirectory(current, args.owner);
    for (const part of args.parentParts) {
      const nextPath = `${PROC_FD_ROOT}/${current.fd}/${part}`;
      let next: FileHandle;
      let created = false;
      try {
        next = await open(
          nextPath,
          fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW,
        );
      } catch (error) {
        if (
          !args.createParents ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
        await mkdir(nextPath, { mode: 0o755 });
        next = await open(
          nextPath,
          fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW,
        );
        created = true;
      }
      if (created && args.owner) {
        await next.chown(args.owner.uid, args.owner.gid);
      }
      await assertDirectory(next, args.owner);
      handles.push(next);
      current = next;
    }
    return {
      entryParent: `${PROC_FD_ROOT}/${current.fd}`,
      handles,
    };
  } catch (error) {
    await closeAll(handles);
    throw error;
  }
};

const openPortableParent = async (args: {
  canonicalRoot: string;
  parentParts: string[];
  createParents: boolean;
  owner?: WorkspaceFileOwner;
}): Promise<{ entryParent: string; handles: FileHandle[] }> => {
  let current = args.canonicalRoot;
  for (const part of args.parentParts) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !ownedBy(metadata, args.owner)
      ) {
        throw new Error(
          "Workspace path contains a symbolic-link or foreign-owned parent.",
        );
      }
    } catch (error) {
      if (
        !args.createParents ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      await mkdir(current, { mode: 0o755 });
      const created = await open(
        current,
        fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW,
      );
      try {
        if (args.owner) {
          await created.chown(args.owner.uid, args.owner.gid);
        }
        await assertDirectory(created, args.owner);
      } finally {
        await created.close();
      }
    }
  }
  return { entryParent: current, handles: [] };
};

const openWorkspaceFile = async (args: {
  filePath: string;
  workspaceRoot: string;
  flags: number;
  createParents?: boolean;
  mode?: number;
  owner?: WorkspaceFileOwner;
  expectedFileOwner?: WorkspaceFileOwner;
}): Promise<OpenedWorkspaceFile> => {
  const { lexicalRoot, relative } = relativeTarget(
    args.filePath,
    args.workspaceRoot,
  );
  const lexicalRootMetadata = await lstat(lexicalRoot);
  if (
    !lexicalRootMetadata.isDirectory() ||
    lexicalRootMetadata.isSymbolicLink() ||
    !ownedBy(lexicalRootMetadata, args.owner)
  ) {
    throw new Error("Shared session workspace root is not a directory.");
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const rootMetadata = await lstat(canonicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Shared session workspace root is not a directory.");
  }
  const parts = relative.split(path.sep);
  const basename = parts.pop()!;
  const anchored =
    process.platform === "linux"
      ? await openLinuxParent({
          canonicalRoot,
          parentParts: parts,
          createParents: Boolean(args.createParents),
          ...(args.owner ? { owner: args.owner } : {}),
        })
      : await openPortableParent({
          canonicalRoot,
          parentParts: parts,
          createParents: Boolean(args.createParents),
          ...(args.owner ? { owner: args.owner } : {}),
        });
  const entryPath = path.join(anchored.entryParent, basename);
  try {
    const handle = await open(entryPath, args.flags | NO_FOLLOW, args.mode);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      !ownedBy(metadata, args.expectedFileOwner)
    ) {
      await handle.close();
      throw new Error(
        "Workspace file must be a regular, singly linked, workspace-owned file.",
      );
    }
    return {
      displayPath: path.join(canonicalRoot, relative),
      entryPath,
      handle,
      parentHandles: anchored.handles,
    };
  } catch (error) {
    await closeAll(anchored.handles);
    throw error;
  }
};

const sameInode = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === 1 &&
  right.nlink === 1 &&
  right.isFile() &&
  !right.isSymbolicLink();

const sameAuthorizedIdentity = (
  actual: Awaited<ReturnType<FileHandle["stat"]>>,
  expected: WorkspaceFileIdentity,
): boolean =>
  actual.dev === expected.dev &&
  actual.ino === expected.ino &&
  actual.size === expected.size &&
  actual.mtimeMs === expected.mtimeMs &&
  actual.ctimeMs === expected.ctimeMs;

const assertEntryStillOpenedFile = async (
  opened: OpenedWorkspaceFile,
): Promise<void> => {
  const [openedMetadata, pathMetadata] = await Promise.all([
    opened.handle.stat(),
    lstat(opened.entryPath),
  ]);
  if (!sameInode(openedMetadata, pathMetadata)) {
    throw new Error("Workspace file changed while it was being authorized.");
  }
};

const readBounded = async (
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> => {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error(`File too large to read safely (${metadata.size} bytes).`);
  }
  const output = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      output.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const finalMetadata = await handle.stat();
  if (
    offset !== output.length ||
    finalMetadata.size !== metadata.size ||
    finalMetadata.mtimeMs !== metadata.mtimeMs ||
    finalMetadata.ctimeMs !== metadata.ctimeMs
  ) {
    output.fill(0);
    throw new Error("Workspace file changed while it was being read.");
  }
  return output;
};

export const readWorkspaceFileNoFollow = async (
  filePath: string,
  workspaceRoot: string,
  maxBytes: number,
  options: BoundaryHooks & { owner?: WorkspaceFileOwner } = {},
): Promise<{
  path: string;
  bytes: Buffer;
  stat: Awaited<ReturnType<FileHandle["stat"]>>;
}> => {
  const opened = await openWorkspaceFile({
    filePath,
    workspaceRoot,
    flags: fsConstants.O_RDONLY,
    ...(options.owner
      ? { owner: options.owner, expectedFileOwner: options.owner }
      : {}),
  });
  try {
    const stat = await opened.handle.stat();
    await options.afterOpen?.();
    const bytes = await readBounded(opened.handle, maxBytes);
    try {
      await assertEntryStillOpenedFile(opened);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
    return { path: opened.displayPath, bytes, stat };
  } finally {
    await opened.handle.close();
    await closeAll(opened.parentHandles);
  }
};

/** Descriptor-authorized metadata without reading file bytes. */
export const statWorkspaceFileNoFollow = async (
  filePath: string,
  workspaceRoot: string,
  options: { owner?: WorkspaceFileOwner } = {},
): Promise<Awaited<ReturnType<FileHandle["stat"]>>> => {
  const opened = await openWorkspaceFile({
    filePath,
    workspaceRoot,
    flags: fsConstants.O_RDONLY,
    ...(options.owner
      ? { owner: options.owner, expectedFileOwner: options.owner }
      : {}),
  });
  try {
    const metadata = await opened.handle.stat();
    await assertEntryStillOpenedFile(opened);
    return metadata;
  } finally {
    await opened.handle.close();
    await closeAll(opened.parentHandles);
  }
};

/** Authorize a directory path component-by-component without following it. */
export const assertWorkspaceDirectoryNoFollow = async (
  directoryPath: string,
  workspaceRoot: string,
  options: { owner?: WorkspaceFileOwner } = {},
): Promise<string> => {
  const { lexicalRoot, relative } = relativeTarget(
    directoryPath,
    workspaceRoot,
  );
  const lexicalRootMetadata = await lstat(lexicalRoot);
  if (
    !lexicalRootMetadata.isDirectory() ||
    lexicalRootMetadata.isSymbolicLink() ||
    !ownedBy(lexicalRootMetadata, options.owner)
  ) {
    throw new Error("Shared session workspace root is not a directory.");
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const parts = relative.split(path.sep);
  const anchored =
    process.platform === "linux"
      ? await openLinuxParent({
          canonicalRoot,
          parentParts: parts,
          createParents: false,
          ...(options.owner ? { owner: options.owner } : {}),
        })
      : await openPortableParent({
          canonicalRoot,
          parentParts: parts,
          createParents: false,
          ...(options.owner ? { owner: options.owner } : {}),
        });
  await closeAll(anchored.handles);
  return path.join(canonicalRoot, relative);
};

export const writeWorkspaceBytesNoFollow = async (
  filePath: string,
  workspaceRoot: string,
  content: Uint8Array,
  options: {
    exclusive?: boolean;
    hooks?: BoundaryHooks;
    owner?: WorkspaceFileOwner;
    expectedStat?: WorkspaceFileIdentity;
  } = {},
): Promise<string> => {
  const existingFlags = fsConstants.O_RDWR;
  const createFlags =
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let opened: OpenedWorkspaceFile;
  let created = false;
  if (options.exclusive) {
    opened = await openWorkspaceFile({
      filePath,
      workspaceRoot,
      flags: createFlags,
      createParents: true,
      mode: 0o666,
      ...(options.owner ? { owner: options.owner } : {}),
    });
    created = true;
  } else {
    try {
      opened = await openWorkspaceFile({
        filePath,
        workspaceRoot,
        flags: existingFlags,
        createParents: true,
        ...(options.owner
          ? { owner: options.owner, expectedFileOwner: options.owner }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      opened = await openWorkspaceFile({
        filePath,
        workspaceRoot,
        flags: createFlags,
        createParents: true,
        mode: 0o666,
        ...(options.owner ? { owner: options.owner } : {}),
      });
      created = true;
    }
  }

  const intended = Buffer.from(content);
  try {
    if (
      options.expectedStat &&
      !sameAuthorizedIdentity(await opened.handle.stat(), options.expectedStat)
    ) {
      throw new Error("Workspace file changed after it was authorized.");
    }
    if (created && options.owner) {
      await opened.handle.chown(options.owner.uid, options.owner.gid);
    }
    await options.hooks?.afterOpen?.();
    await opened.handle.truncate(0);
    let offset = 0;
    while (offset < intended.length) {
      const { bytesWritten } = await opened.handle.write(
        intended,
        offset,
        intended.length - offset,
        offset,
      );
      if (bytesWritten === 0) {
        throw new Error("Workspace file write made no progress.");
      }
      offset += bytesWritten;
    }
    await opened.handle.truncate(intended.length);
    const verification = await readBounded(opened.handle, intended.length);
    const matches = verification.equals(intended);
    verification.fill(0);
    if (!matches) {
      throw new Error("Workspace file write verification failed.");
    }
    await assertEntryStillOpenedFile(opened);
    return opened.displayPath;
  } finally {
    intended.fill(0);
    await opened.handle.close();
    await closeAll(opened.parentHandles);
  }
};

export const writeWorkspaceFileNoFollow = async (
  filePath: string,
  workspaceRoot: string,
  content: string,
  options: {
    exclusive?: boolean;
    hooks?: BoundaryHooks;
    owner?: WorkspaceFileOwner;
    expectedStat?: WorkspaceFileIdentity;
  } = {},
): Promise<string> =>
  writeWorkspaceBytesNoFollow(
    filePath,
    workspaceRoot,
    Buffer.from(content, "utf8"),
    options,
  );

export const unlinkWorkspaceFileNoFollow = async (
  filePath: string,
  workspaceRoot: string,
  options: BoundaryHooks & {
    owner?: WorkspaceFileOwner;
    expectedStat?: WorkspaceFileIdentity;
  } = {},
): Promise<string> => {
  const opened = await openWorkspaceFile({
    filePath,
    workspaceRoot,
    flags: fsConstants.O_RDONLY,
    ...(options.owner
      ? { owner: options.owner, expectedFileOwner: options.owner }
      : {}),
  });
  try {
    await options.afterOpen?.();
    if (
      options.expectedStat &&
      !sameAuthorizedIdentity(await opened.handle.stat(), options.expectedStat)
    ) {
      throw new Error("Workspace file changed after it was authorized.");
    }
    await assertEntryStillOpenedFile(opened);
    const { unlink } = await import("node:fs/promises");
    await unlink(opened.entryPath);
    return opened.displayPath;
  } finally {
    await opened.handle.close();
    await closeAll(opened.parentHandles);
  }
};
