import { sha256Hex } from "./hash.js";

export const TURN_STATE_SCHEMA_VERSION = 1 as const;
export const TURN_STATE_OBJECT_FORMAT = "squashfs-zstd-v1" as const;
export const TURN_STATE_OBJECT_PREFIX = "stella-checkpoints/v1" as const;
export const TURN_STATE_MAX_ARCHIVE_BYTES =
  5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;
const MAX_CANDIDATES = 8;

/**
 * The object-key segment that used to hold the workspace name. An owner has
 * exactly one world now, so it is a constant; it stays in the key so the
 * on-disk layout keeps its owner/world/thread/turn shape.
 */
export const WORLD_REGISTRY_SEGMENT = "world";

export type TurnStateObjectKind = "native";

export type TurnStateArchive = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  kind: TurnStateObjectKind;
  format: typeof TURN_STATE_OBJECT_FORMAT;
  key: string;
  sizeBytes: number;
  sha256: string;
  etag: string;
  complete: true;
};

export type TurnStateNativeCheckpoint = {
  engine: "anthropic";
  sessionId: string;
  cursor: string;
  tree: {
    algorithm: "sha256";
    digest: string;
    entries: number;
    bytes: number;
  };
  mac: string;
};

export type TurnStateIdentity = {
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
};

export type TurnStateCandidate = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  operationId: string;
  requestFingerprint: string;
  historyCursor: string;
  workspace: { historyCursor: string; manifestId: string };
  native?: TurnStateArchive;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
  receipt: string;
  createdAt: number;
};

export type TurnStateWorkspaceHead = {
  historyCursor: string;
  manifestId: string;
};

type ObjectRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  kind: TurnStateObjectKind;
  key: string;
  state: "reserved" | "uploaded" | "referenced" | "retiring";
  descriptor?: TurnStateArchive;
};

type OperationRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  identity: TurnStateIdentity;
  ownerHash: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  requestFingerprint: string;
  historyCursor: string;
  manifestId: string;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
  objectKeys: { native?: string };
  state: "prepared" | "committed";
  receipt?: string;
  publicationReceipt?: string;
  createdAt: number;
};

type ThreadRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  threadId: string;
  committed?: TurnStateCandidate;
  candidates: TurnStateCandidate[];
};

type WorkspaceRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  head?: TurnStateWorkspaceHead;
};

type RetirementRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  objectKeys: string[];
  createdAt: number;
};

export type StrongTurnStateStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: {
    prefix?: string;
    startAfter?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
  transaction<T>(
    closure: (transaction: StrongTurnStateStorage) => Promise<T>,
  ): Promise<T>;
};

const exactText = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const validIdentity = (identity: TurnStateIdentity): boolean =>
  exactText(identity.ownerId) &&
  exactText(identity.ownerGeneration) &&
  exactText(identity.threadId) &&
  exactText(identity.turnId) &&
  Number.isSafeInteger(identity.attemptGeneration) &&
  identity.attemptGeneration > 0;

const objectRecordKey = (key: string): string => `turn-state:v1:object:${key}`;
const operationRecordKey = (operationId: string): string =>
  `turn-state:v1:operation:${operationId}`;
const threadRecordKey = (workspaceHash: string, threadHash: string): string =>
  `turn-state:v1:thread:${workspaceHash}:${threadHash}`;
const workspaceRecordKey = (workspaceHash: string): string =>
  `turn-state:v1:workspace:${workspaceHash}`;
const retirementRecordKey = (operationId: string): string =>
  `turn-state:v1:retirement:${operationId}`;
const ownerMarkerKey = "turn-state:v1:owner";

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const listAll = async <T>(
  storage: StrongTurnStateStorage,
  prefix: string,
): Promise<Map<string, T>> => {
  const output = new Map<string, T>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({
      prefix,
      ...(startAfter ? { startAfter } : {}),
      limit: 128,
    });
    for (const [key, value] of page) output.set(key, value);
    if (page.size < 128) return output;
    startAfter = [...page.keys()].at(-1);
    if (!startAfter) return output;
  }
};

const derivedIdentity = async (identity: TurnStateIdentity) => {
  if (!validIdentity(identity))
    throw new Error("Turn state identity is invalid.");
  const [ownerHash, workspaceHash, threadHash, turnHash] = await Promise.all([
    sha256Hex(identity.ownerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
    sha256Hex(identity.threadId),
    sha256Hex(identity.turnId),
  ]);
  return { ownerHash, workspaceHash, threadHash, turnHash };
};

const validateNativeCheckpoint = (
  checkpoint: TurnStateNativeCheckpoint | undefined,
  historyCursor: string,
): void => {
  if (!checkpoint) return;
  if (
    checkpoint.engine !== "anthropic" ||
    !exactText(checkpoint.sessionId) ||
    checkpoint.cursor !== historyCursor ||
    checkpoint.tree.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/u.test(checkpoint.tree.digest) ||
    !Number.isSafeInteger(checkpoint.tree.entries) ||
    checkpoint.tree.entries <= 0 ||
    !Number.isSafeInteger(checkpoint.tree.bytes) ||
    checkpoint.tree.bytes < 0 ||
    !/^[0-9a-f]{64}$/u.test(checkpoint.mac)
  ) {
    throw new Error("Native turn state checkpoint is invalid.");
  }
};

export type PreparedTurnStateOperation = {
  operationId: string;
  ownerHash: string;
  workspaceHash: string;
  threadHash: string;
  manifestId: string;
  objectKeys: { native?: string };
  replayed: boolean;
};

export const prepareTurnStateOperation = async (
  storage: StrongTurnStateStorage,
  args: {
    identity: TurnStateIdentity;
    requestFingerprint: string;
    historyCursor: string;
    manifestId: string;
    nativeCheckpoint?: TurnStateNativeCheckpoint;
    createdAt: number;
  },
): Promise<PreparedTurnStateOperation> => {
  if (
    !/^[0-9a-f]{64}$/u.test(args.requestFingerprint) ||
    !exactText(args.historyCursor, 1_024) ||
    !/^[0-9a-f]{64}$/u.test(args.manifestId) ||
    !Number.isSafeInteger(args.createdAt) ||
    args.createdAt < 0
  ) {
    throw new Error("Turn state preparation is invalid.");
  }
  validateNativeCheckpoint(args.nativeCheckpoint, args.historyCursor);
  const hashes = await derivedIdentity(args.identity);
  const operationId = await sha256Hex(
    JSON.stringify([
      TURN_STATE_SCHEMA_VERSION,
      args.identity.ownerGeneration,
      args.identity.threadId,
      args.identity.turnId,
      args.identity.attemptGeneration,
      args.requestFingerprint,
      args.historyCursor,
      args.manifestId,
    ]),
  );
  const base = `${TURN_STATE_OBJECT_PREFIX}/${hashes.ownerHash}/${hashes.workspaceHash}/${hashes.threadHash}/${hashes.turnHash}/${args.identity.attemptGeneration}-${operationId}`;
  const objectKeys = args.nativeCheckpoint
    ? { native: `${base}/native.sqsh` }
    : {};
  const operation: OperationRecord = {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    identity: args.identity,
    ...hashes,
    operationId,
    requestFingerprint: args.requestFingerprint,
    historyCursor: args.historyCursor,
    manifestId: args.manifestId,
    ...(args.nativeCheckpoint
      ? { nativeCheckpoint: args.nativeCheckpoint }
      : {}),
    objectKeys,
    state: "prepared",
    createdAt: args.createdAt,
  };
  const replayed = await storage.transaction(async (tx) => {
    const marker = await tx.get<{ ownerHash?: string }>(ownerMarkerKey);
    if (marker && marker.ownerHash !== hashes.ownerHash) {
      throw new Error("Turn state owner registry mismatch.");
    }
    const key = operationRecordKey(operationId);
    const existing = await tx.get<OperationRecord>(key);
    if (existing) {
      if (!sameJson(existing, operation) && existing.state !== "committed") {
        throw new Error(
          "Turn state operation conflicts with its durable replay.",
        );
      }
      if (
        existing.requestFingerprint !== args.requestFingerprint ||
        existing.historyCursor !== args.historyCursor ||
        existing.manifestId !== args.manifestId ||
        !sameJson(existing.identity, args.identity) ||
        !sameJson(existing.nativeCheckpoint, args.nativeCheckpoint) ||
        !sameJson(existing.objectKeys, objectKeys)
      ) {
        throw new Error(
          "Turn state operation conflicts with its durable replay.",
        );
      }
      return true;
    }
    const workspaceState = await tx.get<WorkspaceRecord>(
      workspaceRecordKey(hashes.workspaceHash),
    );
    if (
      workspaceState &&
      (workspaceState.ownerHash !== hashes.ownerHash ||
        workspaceState.ownerGeneration !== args.identity.ownerGeneration)
    ) {
      throw new Error("Turn state workspace owner generation is stale.");
    }
    await tx.put(ownerMarkerKey, {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash: hashes.ownerHash,
    });
    if (!workspaceState) {
      await tx.put(workspaceRecordKey(hashes.workspaceHash), {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: hashes.ownerHash,
        ownerGeneration: args.identity.ownerGeneration,
        workspaceHash: hashes.workspaceHash,
      } satisfies WorkspaceRecord);
    }
    await tx.put(key, operation);
    for (const kind of ["native"] as const) {
      const objectKey = objectKeys[kind];
      if (!objectKey) continue;
      const record: ObjectRecord = {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: hashes.ownerHash,
        ownerGeneration: args.identity.ownerGeneration,
        workspaceHash: hashes.workspaceHash,
        threadHash: hashes.threadHash,
        operationId,
        kind,
        key: objectKey,
        state: "reserved",
      };
      await tx.put(objectRecordKey(objectKey), record);
    }
    return false;
  });
  return {
    operationId,
    ownerHash: hashes.ownerHash,
    workspaceHash: hashes.workspaceHash,
    threadHash: hashes.threadHash,
    manifestId: args.manifestId,
    objectKeys,
    replayed,
  };
};

const validArchive = (archive: TurnStateArchive): boolean =>
  archive.schemaVersion === TURN_STATE_SCHEMA_VERSION &&
  archive.kind === "native" &&
  archive.format === TURN_STATE_OBJECT_FORMAT &&
  archive.key.startsWith(`${TURN_STATE_OBJECT_PREFIX}/`) &&
  Number.isSafeInteger(archive.sizeBytes) &&
  archive.sizeBytes >= 0 &&
  archive.sizeBytes <= TURN_STATE_MAX_ARCHIVE_BYTES &&
  /^[0-9a-f]{64}$/u.test(archive.sha256) &&
  exactText(archive.etag, 512) &&
  archive.complete === true;

export const markTurnStateObjectUploaded = async (
  storage: StrongTurnStateStorage,
  args: { operationId: string; archive: TurnStateArchive },
): Promise<{ replayed: boolean }> => {
  if (
    !/^[0-9a-f]{64}$/u.test(args.operationId) ||
    !validArchive(args.archive)
  ) {
    throw new Error("Turn state archive descriptor is invalid.");
  }
  return await storage.transaction(async (tx) => {
    const operation = await tx.get<OperationRecord>(
      operationRecordKey(args.operationId),
    );
    const expectedKey = operation?.objectKeys[args.archive.kind];
    if (!operation || expectedKey !== args.archive.key) {
      throw new Error("Turn state archive was not pre-registered.");
    }
    const key = objectRecordKey(args.archive.key);
    const existing = await tx.get<ObjectRecord>(key);
    if (!existing || existing.operationId !== args.operationId) {
      throw new Error("Turn state archive reservation is missing.");
    }
    if (existing.descriptor) {
      if (!sameJson(existing.descriptor, args.archive)) {
        throw new Error(
          "Turn state archive replay conflicts with durable bytes.",
        );
      }
      return { replayed: true };
    }
    await tx.put(key, {
      ...existing,
      state: "uploaded",
      descriptor: args.archive,
    } satisfies ObjectRecord);
    return { replayed: false };
  });
};

export const commitTurnStateOperation = async (
  storage: StrongTurnStateStorage,
  args: { operationId: string },
): Promise<{
  candidate: TurnStateCandidate;
  workspaceHead: TurnStateWorkspaceHead;
  replayed: boolean;
}> => {
  if (!/^[0-9a-f]{64}$/u.test(args.operationId)) {
    throw new Error("Turn state operation id is invalid.");
  }
  return await storage.transaction(async (tx) => {
    const operationKey = operationRecordKey(args.operationId);
    const operation = await tx.get<OperationRecord>(operationKey);
    if (!operation) throw new Error("Turn state operation is missing.");
    const threadKey = threadRecordKey(
      operation.workspaceHash,
      operation.threadHash,
    );
    const thread =
      (await tx.get<ThreadRecord>(threadKey)) ??
      ({
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: operation.ownerHash,
        ownerGeneration: operation.identity.ownerGeneration,
        workspaceHash: operation.workspaceHash,
        threadHash: operation.threadHash,
        threadId: operation.identity.threadId,
        candidates: [],
      } satisfies ThreadRecord);
    if (
      thread.ownerHash !== operation.ownerHash ||
      thread.ownerGeneration !== operation.identity.ownerGeneration ||
      thread.threadId !== operation.identity.threadId
    ) {
      throw new Error("Turn state thread owner generation is stale.");
    }
    const workspaceState = await tx.get<WorkspaceRecord>(
      workspaceRecordKey(operation.workspaceHash),
    );
    if (
      !workspaceState ||
      workspaceState.ownerHash !== operation.ownerHash ||
      workspaceState.ownerGeneration !== operation.identity.ownerGeneration
    ) {
      throw new Error("Turn state workspace owner generation is stale.");
    }
    const existing = [
      ...(thread.committed ? [thread.committed] : []),
      ...thread.candidates,
    ].find((candidate) => candidate.operationId === args.operationId);
    const workspaceHead: TurnStateWorkspaceHead = {
      historyCursor: operation.historyCursor,
      manifestId: operation.manifestId,
    };
    if (operation.state === "committed") {
      if (!existing || existing.receipt !== operation.receipt) {
        throw new Error("Turn state committed receipt is inconsistent.");
      }
      return {
        candidate: existing,
        workspaceHead,
        replayed: true,
      };
    }
    const nativeRecord = operation.objectKeys.native
      ? await tx.get<ObjectRecord>(objectRecordKey(operation.objectKeys.native))
      : undefined;
    if (
      operation.objectKeys.native &&
      (nativeRecord?.state !== "uploaded" || !nativeRecord.descriptor)
    ) {
      throw new Error("Turn state operation has incomplete archive uploads.");
    }
    if (
      thread.candidates.some(
        (candidate) => candidate.historyCursor === operation.historyCursor,
      )
    ) {
      throw new Error(
        "Turn state history cursor already has another candidate.",
      );
    }
    if (thread.candidates.length >= MAX_CANDIDATES) {
      throw new Error("Turn state candidate capacity is exhausted.");
    }
    const receipt = await sha256Hex(
      JSON.stringify([
        TURN_STATE_SCHEMA_VERSION,
        operation.operationId,
        operation.requestFingerprint,
        operation.historyCursor,
        operation.manifestId,
        nativeRecord?.descriptor ?? null,
        operation.nativeCheckpoint ?? null,
      ]),
    );
    const candidate: TurnStateCandidate = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      operationId: operation.operationId,
      requestFingerprint: operation.requestFingerprint,
      historyCursor: operation.historyCursor,
      workspace: {
        historyCursor: operation.historyCursor,
        manifestId: operation.manifestId,
      },
      ...(nativeRecord?.descriptor ? { native: nativeRecord.descriptor } : {}),
      ...(operation.nativeCheckpoint
        ? { nativeCheckpoint: operation.nativeCheckpoint }
        : {}),
      receipt,
      createdAt: operation.createdAt,
    };
    await tx.put(threadKey, {
      ...thread,
      candidates: [...thread.candidates, candidate],
    } satisfies ThreadRecord);
    for (const record of [nativeRecord]) {
      if (!record) continue;
      await tx.put(objectRecordKey(record.key), {
        ...record,
        state: "referenced",
      } satisfies ObjectRecord);
    }
    await tx.put(operationKey, {
      ...operation,
      state: "committed",
      receipt,
    } satisfies OperationRecord);
    return { candidate, workspaceHead, replayed: false };
  });
};

const retireOperationObjects = async (
  tx: StrongTurnStateStorage,
  operationId: string,
  objectKeys: string[],
  ownerHash: string,
  ownerGeneration: string,
  workspaceHash: string,
  threadHash: string,
  now: number,
): Promise<void> => {
  if (objectKeys.length === 0) return;
  const key = retirementRecordKey(operationId);
  const existing = await tx.get<RetirementRecord>(key);
  if (
    existing &&
    (existing.ownerHash !== ownerHash ||
      existing.ownerGeneration !== ownerGeneration ||
      existing.workspaceHash !== workspaceHash ||
      existing.operationId !== operationId)
  ) {
    throw new Error("Turn state retirement identity conflicts.");
  }
  const mergedKeys = [
    ...new Set([...(existing?.objectKeys ?? []), ...objectKeys]),
  ];
  await tx.put(key, {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    ownerHash,
    ownerGeneration,
    workspaceHash,
    threadHash: existing?.threadHash ?? threadHash,
    operationId,
    objectKeys: mergedKeys,
    createdAt: existing?.createdAt ?? now,
  } satisfies RetirementRecord);
  for (const objectKey of objectKeys) {
    const record = await tx.get<ObjectRecord>(objectRecordKey(objectKey));
    if (record) {
      await tx.put(objectRecordKey(objectKey), {
        ...record,
        state: "retiring",
      } satisfies ObjectRecord);
    }
  }
};

const retireThreadCandidates = async (
  tx: StrongTurnStateStorage,
  candidates: TurnStateCandidate[],
  ownerHash: string,
  ownerGeneration: string,
  workspaceHash: string,
  threadHash: string,
  now: number,
): Promise<void> => {
  for (const candidate of candidates) {
    await retireOperationObjects(
      tx,
      candidate.operationId,
      candidate.native ? [candidate.native.key] : [],
      ownerHash,
      ownerGeneration,
      workspaceHash,
      threadHash,
      now,
    );
  }
};

export type PublishedTurnStateWorkspace = {
  workspaceHead: TurnStateWorkspaceHead;
  publicationReceipt: string;
  replayed: boolean;
};

/**
 * Publish the bookkeeping head only after the exact origin thread's
 * transcript cursor is canonical. WorldStore already owns and exposes the
 * bytes; this records which manifest most recently completed publication.
 */
export const publishTurnStateWorkspace = async (
  storage: StrongTurnStateStorage,
  args: {
    identity: Pick<
      TurnStateIdentity,
      "ownerId" | "ownerGeneration" | "threadId"
    >;
    canonicalHistoryCursor: string;
    operationId: string;
  },
): Promise<PublishedTurnStateWorkspace> => {
  if (
    !exactText(args.canonicalHistoryCursor, 1_024) ||
    !/^[0-9a-f]{64}$/u.test(args.operationId)
  ) {
    throw new Error("Turn state workspace publication is invalid.");
  }
  const hashes = await derivedIdentity({
    ...args.identity,
    turnId: "publish-workspace",
    attemptGeneration: 1,
  });
  return await storage.transaction(async (tx) => {
    const workspaceKey = workspaceRecordKey(hashes.workspaceHash);
    const threadKey = threadRecordKey(hashes.workspaceHash, hashes.threadHash);
    const [workspaceState, thread, operation] = await Promise.all([
      tx.get<WorkspaceRecord>(workspaceKey),
      tx.get<ThreadRecord>(threadKey),
      tx.get<OperationRecord>(operationRecordKey(args.operationId)),
    ]);
    if (
      !workspaceState ||
      workspaceState.ownerHash !== hashes.ownerHash ||
      workspaceState.ownerGeneration !== args.identity.ownerGeneration
    ) {
      throw new Error("Turn state workspace owner mismatch.");
    }
    if (
      !thread ||
      thread.ownerHash !== hashes.ownerHash ||
      thread.ownerGeneration !== args.identity.ownerGeneration ||
      thread.threadId !== args.identity.threadId
    ) {
      throw new Error("Turn state workspace origin thread is missing.");
    }
    if (
      !operation ||
      operation.state !== "committed" ||
      operation.ownerHash !== hashes.ownerHash ||
      operation.identity.ownerGeneration !== args.identity.ownerGeneration ||
      operation.threadHash !== hashes.threadHash ||
      operation.historyCursor !== args.canonicalHistoryCursor
    ) {
      throw new Error("Turn state workspace operation is missing.");
    }
    const matchingThreadState = [
      ...(thread.committed ? [thread.committed] : []),
      ...thread.candidates,
    ].some(
      (candidate) =>
        candidate.operationId === args.operationId &&
        candidate.historyCursor === args.canonicalHistoryCursor,
    );
    if (!matchingThreadState) {
      throw new Error("Turn state workspace transcript authority is missing.");
    }
    const publicationReceipt =
      operation.publicationReceipt ??
      (await sha256Hex(
        JSON.stringify([
          TURN_STATE_SCHEMA_VERSION,
          hashes.ownerHash,
          args.identity.ownerGeneration,
          hashes.workspaceHash,
          hashes.threadHash,
          args.operationId,
          args.canonicalHistoryCursor,
          "workspace-published",
        ]),
      ));
    const workspaceHead: TurnStateWorkspaceHead = {
      historyCursor: operation.historyCursor,
      manifestId: operation.manifestId,
    };
    if (operation.publicationReceipt) {
      return { workspaceHead, publicationReceipt, replayed: true };
    }
    await tx.put(workspaceKey, {
      ...workspaceState,
      head: workspaceHead,
    } satisfies WorkspaceRecord);
    await tx.put(operationRecordKey(args.operationId), {
      ...operation,
      publicationReceipt,
    } satisfies OperationRecord);
    return { workspaceHead, publicationReceipt, replayed: false };
  });
};

export type ResolvedTurnState = {
  registryPresent: boolean;
  workspace?: TurnStateWorkspaceHead;
  workspacePublication?: {
    operationId: string;
    publishable: boolean;
  };
  threadRegistryPresent: boolean;
  restore?: TurnStateCandidate;
  confirmationRequired: boolean;
};

export const resolveTurnState = async (
  storage: StrongTurnStateStorage,
  args: {
    identity: Pick<
      TurnStateIdentity,
      "ownerId" | "ownerGeneration" | "threadId"
    >;
    canonicalHistoryCursor: string;
    requireNative: boolean;
  },
): Promise<ResolvedTurnState> => {
  if (!exactText(args.canonicalHistoryCursor, 1_024)) {
    throw new Error("Canonical turn state cursor is invalid.");
  }
  const hashes = await derivedIdentity({
    ...args.identity,
    ownerGeneration: args.identity.ownerGeneration,
    turnId: "resolve",
    attemptGeneration: 1,
  });
  return await storage.transaction(async (tx) => {
    const [workspaceState, thread] = await Promise.all([
      tx.get<WorkspaceRecord>(workspaceRecordKey(hashes.workspaceHash)),
      tx.get<ThreadRecord>(
        threadRecordKey(hashes.workspaceHash, hashes.threadHash),
      ),
    ]);
    if (
      workspaceState &&
      (workspaceState.ownerHash !== hashes.ownerHash ||
        workspaceState.ownerGeneration !== args.identity.ownerGeneration)
    ) {
      throw new Error("Turn state workspace owner mismatch.");
    }
    if (
      thread &&
      (thread.ownerHash !== hashes.ownerHash ||
        thread.ownerGeneration !== args.identity.ownerGeneration ||
        thread.threadId !== args.identity.threadId)
    ) {
      throw new Error("Turn state thread owner mismatch.");
    }
    const workspace = workspaceState?.head;
    const matchingCommitted =
      thread?.committed?.historyCursor === args.canonicalHistoryCursor
        ? thread.committed
        : undefined;
    const matchingCandidate = thread?.candidates.find(
      (candidate) => candidate.historyCursor === args.canonicalHistoryCursor,
    );
    const matchingOperation = matchingCandidate
      ? await tx.get<OperationRecord>(
          operationRecordKey(matchingCandidate.operationId),
        )
      : undefined;
    const workspacePublication =
      matchingCandidate &&
      matchingOperation?.state === "committed" &&
      !matchingOperation.publicationReceipt
        ? {
            operationId: matchingCandidate.operationId,
            publishable: true,
          }
        : undefined;
    const restore = matchingCommitted ?? matchingCandidate;
    if (
      restore &&
      args.requireNative &&
      args.canonicalHistoryCursor !== "v1:empty"
    ) {
      if (!restore?.native || !restore.nativeCheckpoint) {
        throw new Error("Canonical native turn state is missing.");
      }
    }
    return {
      registryPresent: Boolean(workspaceState || thread),
      ...(workspace ? { workspace } : {}),
      ...(workspacePublication ? { workspacePublication } : {}),
      threadRegistryPresent: Boolean(thread),
      ...(restore ? { restore } : {}),
      confirmationRequired: Boolean(
        matchingCandidate && restore === matchingCandidate,
      ),
    };
  });
};

export type ConfirmedTurnStateRestore = {
  thread?: {
    restore: TurnStateCandidate;
    promoted: boolean;
    replayed: boolean;
  };
  confirmationReceipt: string;
};

/**
 * Promote only after the caller has restored and verified the exact
 * thread-native state returned by resolveTurnState. Keeping probe and
 * confirmation separate prevents a corrupt/missing candidate from retiring
 * the last recoverable committed state before its bytes have been consumed.
 */
export const confirmTurnStateRestore = async (
  storage: StrongTurnStateStorage,
  args: {
    identity: Pick<
      TurnStateIdentity,
      "ownerId" | "ownerGeneration" | "threadId"
    >;
    canonicalHistoryCursor: string;
    threadOperationId?: string;
    now: number;
  },
): Promise<ConfirmedTurnStateRestore> => {
  if (
    !exactText(args.canonicalHistoryCursor, 1_024) ||
    !args.threadOperationId ||
    (args.threadOperationId !== undefined &&
      !/^[0-9a-f]{64}$/u.test(args.threadOperationId)) ||
    !Number.isSafeInteger(args.now) ||
    args.now < 0
  ) {
    throw new Error("Turn state restore confirmation is invalid.");
  }
  const hashes = await derivedIdentity({
    ...args.identity,
    turnId: "confirm-restore",
    attemptGeneration: 1,
  });
  return await storage.transaction(async (tx) => {
    const threadKey = threadRecordKey(hashes.workspaceHash, hashes.threadHash);
    const thread = await tx.get<ThreadRecord>(threadKey);
    if (
      thread &&
      (thread.ownerHash !== hashes.ownerHash ||
        thread.ownerGeneration !== args.identity.ownerGeneration ||
        thread.threadId !== args.identity.threadId)
    ) {
      throw new Error("Turn state thread owner mismatch.");
    }
    const exactThreadCandidate = (
      candidate: TurnStateCandidate | undefined,
    ): candidate is TurnStateCandidate =>
      Boolean(
        candidate &&
        candidate.operationId === args.threadOperationId &&
        candidate.historyCursor === args.canonicalHistoryCursor,
      );
    const confirmationReceipt = await sha256Hex(
      JSON.stringify([
        TURN_STATE_SCHEMA_VERSION,
        hashes.ownerHash,
        args.identity.ownerGeneration,
        hashes.workspaceHash,
        hashes.threadHash,
        args.threadOperationId ?? null,
        args.canonicalHistoryCursor,
        "restore-confirmed",
      ]),
    );
    let threadConfirmation: ConfirmedTurnStateRestore["thread"];
    if (args.threadOperationId) {
      if (!thread) throw new Error("Turn state restore thread is missing.");
      if (exactThreadCandidate(thread.committed)) {
        threadConfirmation = {
          restore: thread.committed!,
          promoted: false,
          replayed: true,
        };
      } else {
        const restore = thread.candidates.find(exactThreadCandidate);
        if (!restore) {
          throw new Error("Turn state restore candidate is no longer current.");
        }
        const retired = [
          ...(thread.committed ? [thread.committed] : []),
          ...thread.candidates.filter(
            (candidate) => candidate.operationId !== restore.operationId,
          ),
        ];
        await retireThreadCandidates(
          tx,
          retired,
          thread.ownerHash,
          thread.ownerGeneration,
          thread.workspaceHash,
          thread.threadHash,
          args.now,
        );
        await tx.put(threadKey, {
          ...thread,
          committed: restore,
          candidates: [],
        } satisfies ThreadRecord);
        threadConfirmation = {
          restore,
          promoted: true,
          replayed: false,
        };
      }
    }
    return {
      ...(threadConfirmation ? { thread: threadConfirmation } : {}),
      confirmationReceipt,
    };
  });
};

export type TurnStateObjectStore = {
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{
    keys: string[];
    cursor?: string;
    complete: boolean;
  }>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
};

/**
 * Delete archive pairs that a canonical resolve made unreachable. The
 * retirement row is written in the same strong transaction as promotion, so
 * response loss at any delete/HEAD/metadata step is an ordinary exact replay.
 */
export const drainTurnStateRetirements = async (
  storage: StrongTurnStateStorage,
  objectStore: TurnStateObjectStore,
  args: {
    ownerId: string;
    ownerGeneration: string;
    limit?: number;
  },
): Promise<{ pending: boolean; deleted: number; completed: number }> => {
  if (!exactText(args.ownerId) || !exactText(args.ownerGeneration)) {
    throw new Error("Turn state retirement identity is invalid.");
  }
  const limit = args.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 128) {
    throw new Error("Turn state retirement limit is invalid.");
  }
  const ownerHash = await sha256Hex(args.ownerId);
  const prefix = `${TURN_STATE_OBJECT_PREFIX}/${ownerHash}/`;
  const retirements = [
    ...(
      await listAll<RetirementRecord>(storage, "turn-state:v1:retirement:")
    ).entries(),
  ]
    .filter(
      ([, record]) =>
        record.ownerHash === ownerHash &&
        record.ownerGeneration === args.ownerGeneration,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  let pending = retirements.length > limit;
  let deleted = 0;
  let completed = 0;
  for (const [retirementKey, retirement] of retirements.slice(0, limit)) {
    let empty = true;
    for (const objectKey of retirement.objectKeys) {
      if (!objectKey.startsWith(prefix)) {
        empty = false;
        pending = true;
        continue;
      }
      try {
        await objectStore.delete(objectKey);
        if (await objectStore.head(objectKey)) {
          empty = false;
          pending = true;
        } else {
          deleted += 1;
        }
      } catch {
        empty = false;
        pending = true;
      }
    }
    if (!empty) continue;
    const cleared = await storage.transaction(async (tx) => {
      const current = await tx.get<RetirementRecord>(retirementKey);
      if (!current || !sameJson(current, retirement)) return false;
      for (const objectKey of current.objectKeys) {
        const object = await tx.get<ObjectRecord>(objectRecordKey(objectKey));
        if (
          object &&
          (object.operationId !== current.operationId ||
            object.state !== "retiring")
        ) {
          throw new Error("Turn state retirement object was re-referenced.");
        }
        if (object) await tx.delete(objectRecordKey(objectKey));
      }
      const operationKey = operationRecordKey(current.operationId);
      const operation = await tx.get<OperationRecord>(operationKey);
      if (operation?.operationId === current.operationId) {
        await tx.delete(operationKey);
      }
      await tx.delete(retirementKey);
      return true;
    });
    if (cleared) completed += 1;
  }
  const remaining = [
    ...(
      await listAll<RetirementRecord>(storage, "turn-state:v1:retirement:")
    ).values(),
  ].some(
    (record) =>
      record.ownerHash === ownerHash &&
      record.ownerGeneration === args.ownerGeneration,
  );
  return { pending: pending || remaining, deleted, completed };
};

const registryScopeMatches = (
  record: { ownerHash?: string },
  ownerHash: string,
): boolean => record.ownerHash === ownerHash;

export const purgeTurnState = async (
  storage: StrongTurnStateStorage,
  objectStore: TurnStateObjectStore,
  args: {
    ownerId: string;
    ownerPurgeFence: "blocked";
  },
): Promise<{
  pending: boolean;
  deleted: number;
  receipt?: string;
  prefix: string;
}> => {
  if (args.ownerPurgeFence !== "blocked" || !exactText(args.ownerId)) {
    throw new Error("Turn state purge requires the blocked owner fence.");
  }
  const ownerHash = await sha256Hex(args.ownerId);
  const prefix = `${TURN_STATE_OBJECT_PREFIX}/${ownerHash}/`;
  const registryObjects = await listAll<ObjectRecord>(
    storage,
    "turn-state:v1:object:",
  );
  const expected = new Set(
    [...registryObjects.values()]
      .filter((record) => registryScopeMatches(record, ownerHash))
      .map((record) => record.key),
  );
  let cursor: string | undefined;
  for (;;) {
    const page = await objectStore.list(prefix, cursor);
    for (const key of page.keys) {
      if (!key.startsWith(prefix)) {
        throw new Error("Turn state object store escaped its purge prefix.");
      }
      expected.add(key);
    }
    if (page.complete) break;
    if (!page.cursor || page.cursor === cursor) {
      throw new Error("Turn state object listing did not advance.");
    }
    cursor = page.cursor;
  }
  let deleted = 0;
  let pending = false;
  for (const key of [...expected].sort()) {
    const recordKey = objectRecordKey(key);
    const record = await storage.get<ObjectRecord>(recordKey);
    if (record && registryScopeMatches(record, ownerHash)) {
      await storage.put(recordKey, { ...record, state: "retiring" });
    }
    try {
      await objectStore.delete(key);
      if (await objectStore.head(key)) {
        pending = true;
        continue;
      }
      deleted += 1;
      if (record && registryScopeMatches(record, ownerHash)) {
        await storage.delete(recordKey);
      }
    } catch {
      pending = true;
    }
  }
  // A second complete prefix scan is the authority that catches uploads which
  // completed after the first list but before their pre-registered key was
  // reconciled. Owner purge keeps all writers fenced while this runs.
  cursor = undefined;
  for (;;) {
    const page = await objectStore.list(prefix, cursor);
    if (page.keys.length > 0) pending = true;
    if (page.complete) break;
    if (!page.cursor || page.cursor === cursor) {
      pending = true;
      break;
    }
    cursor = page.cursor;
  }
  const remaining = [
    ...(await listAll<ObjectRecord>(storage, "turn-state:v1:object:")).values(),
  ].some((record) => registryScopeMatches(record, ownerHash));
  if (remaining) pending = true;
  if (pending) return { pending: true, deleted, prefix };

  for (const [key, value] of await listAll<Record<string, unknown>>(
    storage,
    "turn-state:v1:",
  )) {
    if (key === ownerMarkerKey) continue;
    if (registryScopeMatches(value, ownerHash)) await storage.delete(key);
  }
  await storage.delete(ownerMarkerKey);
  return {
    pending: false,
    deleted,
    prefix,
    receipt: await sha256Hex(
      JSON.stringify([TURN_STATE_SCHEMA_VERSION, ownerHash, prefix, "empty"]),
    ),
  };
};

export const assertTurnStateTransferSourceEmpty = async (
  storage: StrongTurnStateStorage,
  objectStore: TurnStateObjectStore,
  args: { ownerId: string },
): Promise<string> => {
  const ownerHash = await sha256Hex(args.ownerId);
  const prefix = `${TURN_STATE_OBJECT_PREFIX}/${ownerHash}/`;
  const records = await listAll<ObjectRecord>(storage, "turn-state:v1:object:");
  if (
    [...records.values()].some((record) =>
      registryScopeMatches(record, ownerHash),
    )
  ) {
    throw new Error("Turn state transfer source is not empty.");
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await objectStore.list(prefix, cursor);
    if (page.keys.length > 0) {
      throw new Error("Turn state transfer source bytes are not empty.");
    }
    if (page.complete) break;
    if (!page.cursor || page.cursor === cursor) {
      throw new Error("Turn state transfer source scan did not advance.");
    }
    cursor = page.cursor;
  }
  return await sha256Hex(
    JSON.stringify([
      TURN_STATE_SCHEMA_VERSION,
      ownerHash,
      prefix,
      "transfer-source-empty",
    ]),
  );
};
