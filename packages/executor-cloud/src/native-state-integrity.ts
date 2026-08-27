import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type PersistentNativeEngine = "anthropic";

export const NATIVE_STATE_ATTESTATION_FILE =
  ".stella-native-state-attestation.json";

export type NativeStateOwner = Readonly<{ uid: number; gid: number }>;

const ROOT_NATIVE_STATE_OWNER: NativeStateOwner = { uid: 0, gid: 0 };

type NativeStateTreeEntry = {
  path: string;
  type: "directory" | "file";
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  sha256?: string;
};

export type NativeStateTree = {
  algorithm: "sha256";
  digest: string;
  entries: number;
  bytes: number;
};

export type NativeStateAttestation = {
  version: 2;
  engine: PersistentNativeEngine;
  threadId: string;
  sessionId: string;
  cursor: string;
  tree: NativeStateTree;
  mac: string;
};

const hexSha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const modeBits = (mode: number): number => mode & 0o7777;
const comparePath = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const nativeStateOwner = (
  expectedOwner?: NativeStateOwner,
): NativeStateOwner => {
  const owner = expectedOwner ?? ROOT_NATIVE_STATE_OWNER;
  if (
    !Number.isSafeInteger(owner.uid) ||
    owner.uid < 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  ) {
    throw new Error("Native session state owner is invalid.");
  }
  return owner;
};

const assertExpectedOwner = (
  details: { uid: number; gid: number },
  relativePath: string,
  expectedOwner?: NativeStateOwner,
): void => {
  const expected = nativeStateOwner(expectedOwner);
  if (details.uid !== expected.uid || details.gid !== expected.gid) {
    throw new Error(
      `Native session state has the wrong owner at ${relativePath}; expected ${expected.uid}:${expected.gid}, received ${details.uid}:${details.gid}.`,
    );
  }
};

const assertPrivateDirectory = async (
  directory: string,
  label: string,
  expectedOwner?: NativeStateOwner,
): Promise<void> => {
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} is not a canonical real directory.`);
  }
  assertExpectedOwner(details, label, expectedOwner);
  if (modeBits(details.mode) !== 0o700) {
    throw new Error(`${label} must have permissions 0700.`);
  }
};

const assertRegularPrivateFile = (
  details: {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    uid: number;
    gid: number;
    nlink: number;
  },
  relativePath: string,
  expectedOwner?: NativeStateOwner,
): void => {
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(
      `Native session state contains an unsupported filesystem entry: ${relativePath}`,
    );
  }
  assertExpectedOwner(details, relativePath, expectedOwner);
  if (details.nlink !== 1) {
    throw new Error(
      `Native session state contains a forbidden hard link: ${relativePath}`,
    );
  }
  if (modeBits(details.mode) !== 0o600) {
    throw new Error(
      `Native session state file must have permissions 0600: ${relativePath}`,
    );
  }
};

/**
 * Claude may create ordinary config files with a permissive umask. Once the
 * CLI has exited, normalize every real directory/file before signing it. We
 * never repair ownership, links, or unsupported entry types: those are
 * integrity failures, not permission-hardening opportunities.
 */
const hardenNativeStatePermissions = async (
  stateRoot: string,
  expectedOwner?: NativeStateOwner,
): Promise<void> => {
  const entries: Array<{
    absolutePath: string;
    type: "directory" | "file";
  }> = [];
  const walk = async (
    absolutePath: string,
    relativePath: string,
  ): Promise<void> => {
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) {
      throw new Error(
        `Native session state contains a forbidden symbolic link: ${relativePath}`,
      );
    }
    assertExpectedOwner(details, relativePath, expectedOwner);
    if (details.isDirectory()) {
      entries.push({ absolutePath, type: "directory" });
      const children = await readdir(absolutePath, { withFileTypes: true });
      children.sort((left, right) => comparePath(left.name, right.name));
      for (const child of children) {
        const childRelativePath =
          relativePath === "." ? child.name : `${relativePath}/${child.name}`;
        if (childRelativePath === NATIVE_STATE_ATTESTATION_FILE) continue;
        await walk(path.join(absolutePath, child.name), childRelativePath);
      }
      return;
    }
    if (!details.isFile()) {
      throw new Error(
        `Native session state contains an unsupported filesystem entry: ${relativePath}`,
      );
    }
    if (details.nlink !== 1) {
      throw new Error(
        `Native session state contains a forbidden hard link: ${relativePath}`,
      );
    }
    entries.push({ absolutePath, type: "file" });
  };

  await walk(stateRoot, ".");
  for (const entry of entries) {
    await chmod(entry.absolutePath, entry.type === "directory" ? 0o700 : 0o600);
  }
};

const collectNativeStateTreeEntries = async (
  stateRoot: string,
  expectedOwner?: NativeStateOwner,
): Promise<NativeStateTreeEntry[]> => {
  await assertPrivateDirectory(
    stateRoot,
    "Native session state root",
    expectedOwner,
  );
  const rootDetails = await lstat(stateRoot);

  const entries: NativeStateTreeEntry[] = [
    {
      path: ".",
      type: "directory",
      mode: modeBits(rootDetails.mode),
      uid: rootDetails.uid,
      gid: rootDetails.gid,
      nlink: rootDetails.nlink,
      size: 0,
    },
  ];

  const walk = async (directory: string, relativeDirectory: string) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (relativePath === NATIVE_STATE_ATTESTATION_FILE) continue;

      const absolutePath = path.join(directory, child.name);
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) {
        throw new Error(
          `Native session state contains a forbidden symbolic link: ${relativePath}`,
        );
      }
      if (details.isDirectory()) {
        assertExpectedOwner(details, relativePath, expectedOwner);
        if (modeBits(details.mode) !== 0o700) {
          throw new Error(
            `Native session state directory must have permissions 0700: ${relativePath}`,
          );
        }
        entries.push({
          path: relativePath,
          type: "directory",
          mode: modeBits(details.mode),
          uid: details.uid,
          gid: details.gid,
          nlink: details.nlink,
          size: 0,
        });
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!details.isFile()) {
        throw new Error(
          `Native session state contains an unsupported filesystem entry: ${relativePath}`,
        );
      }
      assertRegularPrivateFile(details, relativePath, expectedOwner);
      const bytes = await readFile(absolutePath);
      entries.push({
        path: relativePath,
        type: "file",
        mode: modeBits(details.mode),
        uid: details.uid,
        gid: details.gid,
        nlink: details.nlink,
        size: bytes.byteLength,
        sha256: hexSha256(bytes),
      });
    }
  };

  await walk(stateRoot, "");
  entries.sort((left, right) => comparePath(left.path, right.path));
  return entries;
};

/**
 * Hash every byte plus every path, entry type, permission mode, owner, group,
 * and link count in the resumable native state. Symlinks and hard-linked files
 * are rejected instead of followed: either could make the signed tree depend
 * on bytes outside the private checkpoint.
 */
export const nativeStateTree = async (
  stateRoot: string,
  expectedOwner?: NativeStateOwner,
): Promise<NativeStateTree> => {
  const entries = await collectNativeStateTreeEntries(stateRoot, expectedOwner);
  return {
    algorithm: "sha256",
    digest: hexSha256(JSON.stringify(entries)),
    entries: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
};

const unsignedAttestationPayload = (
  value: Omit<NativeStateAttestation, "mac">,
): string =>
  JSON.stringify([
    value.version,
    value.engine,
    value.threadId,
    value.sessionId,
    value.cursor,
    value.tree.algorithm,
    value.tree.digest,
    value.tree.entries,
    value.tree.bytes,
  ]);

const attestationMac = (
  value: Omit<NativeStateAttestation, "mac">,
  integrityKey: string,
): string =>
  createHmac("sha256", integrityKey)
    .update(unsignedAttestationPayload(value))
    .digest("hex");

const validTreeShape = (value: unknown): value is NativeStateTree => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NativeStateTree>;
  return (
    candidate.algorithm === "sha256" &&
    typeof candidate.digest === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.digest) &&
    typeof candidate.entries === "number" &&
    Number.isSafeInteger(candidate.entries) &&
    candidate.entries > 0 &&
    typeof candidate.bytes === "number" &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes >= 0
  );
};

const parseAttestation = (value: unknown): NativeStateAttestation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<NativeStateAttestation>;
  if (
    candidate.version !== 2 ||
    candidate.engine !== "anthropic" ||
    typeof candidate.threadId !== "string" ||
    !candidate.threadId ||
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    typeof candidate.cursor !== "string" ||
    !candidate.cursor ||
    !validTreeShape(candidate.tree) ||
    typeof candidate.mac !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.mac)
  ) {
    return null;
  }
  return candidate as NativeStateAttestation;
};

const equalHexDigest = (left: string, right: string): boolean =>
  /^[0-9a-f]{64}$/.test(left) &&
  /^[0-9a-f]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

const readAttestation = async (
  stateRoot: string,
  expectedOwner?: NativeStateOwner,
): Promise<NativeStateAttestation | null> => {
  await assertPrivateDirectory(
    stateRoot,
    "Native session state root",
    expectedOwner,
  );
  const attestationPath = path.join(stateRoot, NATIVE_STATE_ATTESTATION_FILE);
  try {
    const details = await lstat(attestationPath);
    assertRegularPrivateFile(
      details,
      NATIVE_STATE_ATTESTATION_FILE,
      expectedOwner,
    );
    const raw = await readFile(attestationPath, "utf8");
    return parseAttestation(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
};

export const createNativeStateAttestation = async (args: {
  stateRoot: string;
  engine: PersistentNativeEngine;
  threadId: string;
  sessionId: string;
  cursor: string;
  integrityKey: string;
  /** Unit tests may override the production-required root owner. */
  expectedOwner?: NativeStateOwner;
}): Promise<NativeStateAttestation> => {
  const unsigned = {
    version: 2 as const,
    engine: args.engine,
    threadId: args.threadId,
    sessionId: args.sessionId,
    cursor: args.cursor,
    tree: await nativeStateTree(args.stateRoot, args.expectedOwner),
  };
  return {
    ...unsigned,
    mac: attestationMac(unsigned, args.integrityKey),
  };
};

/**
 * Write only after the native CLI has exited. The manifest is excluded from
 * its own tree hash, and the sibling temporary file keeps a crash from
 * replacing the last valid attestation with a partial JSON document.
 */
export const sealNativeState = async (args: {
  stateRoot: string;
  engine: PersistentNativeEngine;
  threadId: string;
  sessionId: string;
  cursor: string;
  integrityKey: string;
  /** Unit tests may override the production-required root owner. */
  expectedOwner?: NativeStateOwner;
}): Promise<NativeStateAttestation> => {
  const parent = path.dirname(args.stateRoot);
  await assertPrivateDirectory(
    parent,
    "Native session state parent",
    args.expectedOwner,
  );
  try {
    await mkdir(args.stateRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const priorAttestationPath = path.join(
    args.stateRoot,
    NATIVE_STATE_ATTESTATION_FILE,
  );
  let createdPlaceholder = false;
  try {
    const priorAttestation = await lstat(priorAttestationPath);
    assertRegularPrivateFile(
      priorAttestation,
      NATIVE_STATE_ATTESTATION_FILE,
      args.expectedOwner,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await hardenNativeStatePermissions(args.stateRoot, args.expectedOwner);
  try {
    await lstat(priorAttestationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Some filesystems include ordinary directory entries in st_nlink. Put a
    // private placeholder at the excluded manifest path before hashing so the
    // directory metadata is identical after the atomic manifest replacement.
    await writeFile(priorAttestationPath, "", {
      flag: "wx",
      mode: 0o600,
    });
    createdPlaceholder = true;
  }
  try {
    const attestation = await createNativeStateAttestation(args);
    const temporaryPath = path.join(
      parent,
      `.${path.basename(args.stateRoot)}-attestation-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(attestation)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, priorAttestationPath);
      const storedDetails = await lstat(priorAttestationPath);
      assertRegularPrivateFile(
        storedDetails,
        NATIVE_STATE_ATTESTATION_FILE,
        args.expectedOwner,
      );
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return attestation;
  } catch (error) {
    if (createdPlaceholder) {
      await rm(priorAttestationPath, { force: true });
    }
    throw error;
  }
};

export const assertNativeState = async (args: {
  stateRoot: string;
  engine: PersistentNativeEngine;
  threadId: string;
  sessionId: string;
  expectedCursor: string;
  integrityKey: string;
  /** Unit tests may override the production-required root owner. */
  expectedOwner?: NativeStateOwner;
}): Promise<NativeStateAttestation> => {
  const stored = await readAttestation(args.stateRoot, args.expectedOwner);
  if (
    !stored ||
    stored.engine !== args.engine ||
    stored.threadId !== args.threadId ||
    stored.sessionId !== args.sessionId ||
    stored.cursor !== args.expectedCursor
  ) {
    throw new Error(
      "Native agent session state does not match the authoritative cloud transcript; refusing to resume.",
    );
  }

  const unsigned: Omit<NativeStateAttestation, "mac"> = {
    version: stored.version,
    engine: stored.engine,
    threadId: stored.threadId,
    sessionId: stored.sessionId,
    cursor: stored.cursor,
    tree: stored.tree,
  };
  const expectedMac = attestationMac(unsigned, args.integrityKey);
  if (!equalHexDigest(stored.mac, expectedMac)) {
    throw new Error(
      "Native agent session state attestation is invalid; refusing to resume.",
    );
  }

  const actualTree = await nativeStateTree(args.stateRoot, args.expectedOwner);
  if (
    actualTree.algorithm !== stored.tree.algorithm ||
    actualTree.entries !== stored.tree.entries ||
    actualTree.bytes !== stored.tree.bytes ||
    !equalHexDigest(actualTree.digest, stored.tree.digest)
  ) {
    throw new Error(
      "Native agent session state bytes have changed since checkpoint; refusing to resume.",
    );
  }
  return stored;
};

export const assertFreshNativeState = async (
  stateRoot: string,
  /** Unit tests may override the production-required root owner. */
  expectedOwner?: NativeStateOwner,
): Promise<void> => {
  try {
    await assertPrivateDirectory(
      stateRoot,
      "Native session state root",
      expectedOwner,
    );
    const entries = await readdir(stateRoot);
    if (entries.length === 0) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertPrivateDirectory(
        path.dirname(stateRoot),
        "Native session state parent",
        expectedOwner,
      );
      return;
    }
    throw error;
  }
  throw new Error(
    "Unexpected native agent session state exists for a fresh cloud transcript; refusing to start.",
  );
};
