import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createDurableObjectTurnStateStorage,
  createR2TurnStateObjectStore,
  handleTurnStateOwnerRoute,
  type TurnStateTransferActivationResponse,
  type TurnStateTransferDestinationStatus,
  type TurnStateTransferExportResponse,
  type TurnStateOwnerFence,
} from "../src/turn-state-owner-routes.js";
import {
  TURN_STATE_MAX_ARCHIVE_BYTES,
  turnStateArchiveMetadata,
  uploadTurnStateArchive,
  type TurnStateArchiveSession,
} from "../src/turn-state-archive.js";
import { validNativeStateCheckpointMac } from "../src/native-state-checkpoint.js";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_OBJECT_PREFIX,
  TURN_STATE_SCHEMA_VERSION,
  drainTurnStateRetirements,
  type PreparedTurnStateOperation,
  type TurnStateArchive,
  type TurnStateNativeCheckpoint,
} from "../src/turn-state-registry.js";

const clone = <T>(value: T): T => structuredClone(value);
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type StorageListOptions = {
  prefix?: string;
  startAfter?: string;
  limit?: number;
};

class FakeDurableObjectStorage {
  private values = new Map<string, unknown>();
  readonly listCalls: StorageListOptions[] = [];

  private view(values: Map<string, unknown>): Record<string, unknown> {
    return {
      get: async <T>(key: string): Promise<T | undefined> => {
        const value = values.get(key);
        return value === undefined ? undefined : clone(value as T);
      },
      put: async (key: string, value: unknown): Promise<void> => {
        values.set(key, clone(value));
      },
      delete: async (key: string): Promise<boolean> => values.delete(key),
      list: async <T>(
        options: StorageListOptions = {},
      ): Promise<Map<string, T>> => {
        this.listCalls.push({ ...options });
        const rows = [...values]
          .filter(
            ([key]) =>
              (!options.prefix || key.startsWith(options.prefix)) &&
              (!options.startAfter || key > options.startAfter),
          )
          .sort(([left], [right]) => compare(left, right))
          .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER)
          .map(([key, value]) => [key, clone(value as T)] as const);
        return new Map(rows);
      },
    };
  }

  asStorage(): DurableObjectStorage {
    const root = this.view(this.values);
    return {
      ...root,
      transaction: async <T>(
        closure: (transaction: DurableObjectTransaction) => Promise<T>,
      ): Promise<T> => {
        const pending = new Map(
          [...this.values].map(([key, value]) => [key, clone(value)]),
        );
        const result = await closure(
          this.view(pending) as unknown as DurableObjectTransaction,
        );
        this.values = pending;
        return result;
      },
    } as unknown as DurableObjectStorage;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, clone(value));
  }

  entries(prefix = ""): Map<string, unknown> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => compare(left, right))
        .map(([key, value]) => [key, clone(value)]),
    );
  }
}

type FakeObject = {
  key: string;
  size: number;
  etag: string;
  bytes: Uint8Array;
  checksums: R2Checksums;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
};

class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedLength: number) {
    let received = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expectedLength) {
          controller.error(new Error("fixed stream exceeded expected length"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (received !== expectedLength) {
          controller.error(new Error("fixed stream ended at wrong length"));
        }
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
}

Object.defineProperty(globalThis, "FixedLengthStream", {
  configurable: true,
  value: TestFixedLengthStream,
  writable: true,
});

const byteStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });

class RouteArchiveSession {
  readonly commands: string[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  async exec(command: string) {
    this.commands.push(command);
    const stdout = command.includes("mksquashfs ")
      ? [
          `STELLA_ARCHIVE_SIZE=${this.bytes.byteLength}`,
          `STELLA_ARCHIVE_SHA256=${createHash("sha256").update(this.bytes).digest("hex")}`,
          "",
        ].join("\n")
      : "";
    return {
      success: true,
      exitCode: 0,
      stdout,
      stderr: "",
      command,
      duration: 1,
      timestamp: new Date(0).toISOString(),
    };
  }

  async readFile(path: string) {
    return {
      success: true as const,
      path,
      content: byteStream(this.bytes),
      size: this.bytes.byteLength,
      mimeType: "application/vnd.squashfs",
      timestamp: new Date(0).toISOString(),
    };
  }

  async writeFile(path: string, content: string | ReadableStream<Uint8Array>) {
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : await collectBytes(content);
    return {
      success: true as const,
      path,
      bytesWritten: bytes.byteLength,
      timestamp: new Date(0).toISOString(),
    };
  }

  asSession(): TurnStateArchiveSession {
    return this as unknown as TurnStateArchiveSession;
  }
}

const collectBytes = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const arrayBufferHex = (value: ArrayBuffer): string =>
  Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const archiveBytes = (kind: "workspace" | "native"): Uint8Array =>
  new Uint8Array(12).fill(kind === "workspace" ? 0x77 : 0x6e);

const hexBytes = (value: string): ArrayBuffer => {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
};

class FakeR2Bucket {
  private readonly objects = new Map<string, FakeObject>();
  onList?: (options: R2ListOptions) => void;
  readonly listCalls: Array<{
    prefix?: string;
    cursor?: string;
    limit?: number;
  }> = [];

  constructor(private readonly pageSize = 1_000) {}

  asBucket(): R2Bucket {
    return {
      list: async (options: R2ListOptions = {}): Promise<R2Objects> => {
        this.listCalls.push({ ...options });
        this.onList?.(options);
        const rows = [...this.objects.values()]
          .filter(
            (object) =>
              (!options.prefix || object.key.startsWith(options.prefix)) &&
              (!options.cursor || object.key > options.cursor),
          )
          .sort((left, right) => compare(left.key, right.key));
        const limit = Math.min(options.limit ?? 1_000, this.pageSize);
        const objects = rows.slice(0, limit) as unknown as R2Object[];
        if (rows.length > limit) {
          return {
            objects,
            delimitedPrefixes: [],
            truncated: true,
            cursor: objects.at(-1)!.key,
          };
        }
        return { objects, delimitedPrefixes: [], truncated: false };
      },
      delete: async (keys: string | string[]): Promise<void> => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          this.objects.delete(key);
        }
      },
      head: async (key: string): Promise<R2Object | null> => {
        const object = this.objects.get(key);
        return object ? this.publicObject(object) : null;
      },
      get: async (
        key: string,
        options?: R2GetOptions,
      ): Promise<R2ObjectBody | R2Object | null> => {
        const object = this.objects.get(key);
        if (!object) return null;
        const onlyIf = options?.onlyIf as { etagMatches?: string } | undefined;
        if (onlyIf?.etagMatches && onlyIf.etagMatches !== object.etag) {
          return this.publicObject(object);
        }
        return {
          ...this.publicObject(object),
          body: byteStream(object.bytes),
          bodyUsed: false,
          arrayBuffer: async () => object.bytes.slice().buffer,
          bytes: async () => object.bytes.slice(),
          text: async () => new TextDecoder().decode(object.bytes),
          json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
          blob: async () => new Blob([object.bytes]),
          writeHttpMetadata: () => undefined,
        } as unknown as R2ObjectBody;
      },
      put: async (
        key: string,
        value: R2PutValue,
        options?: R2PutOptions,
      ): Promise<R2Object | null> => {
        if (
          this.objects.has(key) &&
          (options?.onlyIf as { etagDoesNotMatch?: string } | undefined)
            ?.etagDoesNotMatch === "*"
        ) {
          return null;
        }
        if (!(value instanceof ReadableStream)) {
          throw new Error("fake R2 upload requires a stream");
        }
        const bytes = await collectBytes(value);
        const actualSha = createHash("sha256").update(bytes).digest("hex");
        if (
          options?.sha256 instanceof ArrayBuffer &&
          arrayBufferHex(options.sha256) !== actualSha
        ) {
          throw new Error("fake R2 checksum mismatch");
        }
        const object: FakeObject = {
          key,
          size: bytes.byteLength,
          etag: `etag-${actualSha.slice(0, 24)}`,
          bytes,
          checksums: {
            sha256: hexBytes(actualSha),
            toJSON: () => ({ sha256: actualSha }),
          },
          ...(options?.httpMetadata
            ? { httpMetadata: { ...options.httpMetadata } }
            : {}),
          ...(options?.customMetadata
            ? { customMetadata: { ...options.customMetadata } }
            : {}),
        };
        this.objects.set(key, object);
        return this.publicObject(object);
      },
    } as unknown as R2Bucket;
  }

  private publicObject(object: FakeObject): R2Object {
    return {
      ...object,
      bytes: undefined,
      ...(object.httpMetadata
        ? { httpMetadata: { ...object.httpMetadata } }
        : {}),
      ...(object.customMetadata
        ? { customMetadata: { ...object.customMetadata } }
        : {}),
      writeHttpMetadata: () => undefined,
    } as unknown as R2Object;
  }

  put(
    key: string,
    size: number,
    etag: string,
    archive?: TurnStateArchive,
  ): void {
    const sha256 =
      archive?.sha256 ?? createHash("sha256").update(key).digest("hex");
    const bytes = archive
      ? archiveBytes(archive.kind)
      : new Uint8Array(size).fill(7);
    this.objects.set(key, {
      key,
      size,
      etag,
      bytes,
      checksums: {
        sha256: hexBytes(sha256),
        toJSON: () => ({ sha256 }),
      },
      ...(archive
        ? {
            httpMetadata: { contentType: "application/vnd.squashfs" },
            customMetadata: turnStateArchiveMetadata(
              archive,
              archive.kind === "workspace"
                ? { kind: "workspace", workspaceRoot: "/workspace/drive" }
                : { kind: "native" },
            ),
          }
        : {}),
    });
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort(compare);
  }
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const ownerId = "owner-1";
const ownerGeneration = "owner-generation-1";
const fenceGeneration = "fence-generation-1";
const workspace = "drive";
const threadId = "thread-1";
const nativeIntegritySecret = "test-builder-service-secret";

const integrityKey = (
  scopedOwnerId: string,
  scopedOwnerGeneration: string,
  scopedThreadId: string,
): string =>
  digest(
    [
      "stella-native-state-v2",
      nativeIntegritySecret,
      scopedOwnerId,
      scopedOwnerGeneration,
      scopedThreadId,
    ].join("\u0000"),
  );

const signedNativeCheckpoint = (
  turn: number,
  scopedOwnerId = ownerId,
  scopedOwnerGeneration = ownerGeneration,
  scopedThreadId = threadId,
): TurnStateNativeCheckpoint => {
  const unsigned = {
    engine: "anthropic" as const,
    sessionId: `native-session-${turn}`,
    cursor: `cursor-${turn}`,
    tree: {
      algorithm: "sha256" as const,
      digest: digest(`native-tree-${turn}`),
      entries: turn + 1,
      bytes: archiveBytes("native").byteLength,
    },
  };
  const payload = JSON.stringify([
    2,
    unsigned.engine,
    scopedThreadId,
    unsigned.sessionId,
    unsigned.cursor,
    unsigned.tree.algorithm,
    unsigned.tree.digest,
    unsigned.tree.entries,
    unsigned.tree.bytes,
  ]);
  return {
    ...unsigned,
    mac: createHmac(
      "sha256",
      integrityKey(scopedOwnerId, scopedOwnerGeneration, scopedThreadId),
    )
      .update(payload)
      .digest("hex"),
  };
};

const lease = (turn: number) => ({
  leaseId: `lease-${turn}`,
  sessionId: `session-${turn}`,
  turnId: `turn-${turn}`,
  ownerGeneration,
  namespace: "build" as const,
  role: "run" as const,
  workspace,
});

const openFence = (turn: number): TurnStateOwnerFence => {
  const active = lease(turn);
  return {
    ownerId,
    generation: fenceGeneration,
    state: "open",
    active: { [active.leaseId]: active },
  };
};

const common = (turn: number) => ({
  schemaVersion: TURN_STATE_SCHEMA_VERSION,
  ownerId,
  ownerGeneration,
  generation: fenceGeneration,
  leaseId: `lease-${turn}`,
  sessionId: `session-${turn}`,
  turnId: `turn-${turn}`,
});

const openFenceFor = (
  scopedOwnerId: string,
  scopedOwnerGeneration: string,
  turn: number,
): TurnStateOwnerFence => {
  const scopedLease = {
    leaseId: `lease-${turn}`,
    sessionId: `session-${turn}`,
    turnId: `turn-${turn}`,
    ownerGeneration: scopedOwnerGeneration,
    namespace: "build" as const,
    role: "run" as const,
    workspace,
  };
  return {
    ownerId: scopedOwnerId,
    generation: fenceGeneration,
    state: "open",
    active: { [scopedLease.leaseId]: scopedLease },
  };
};

const commonFor = (
  scopedOwnerId: string,
  scopedOwnerGeneration: string,
  turn: number,
) => ({
  schemaVersion: TURN_STATE_SCHEMA_VERSION,
  ownerId: scopedOwnerId,
  ownerGeneration: scopedOwnerGeneration,
  generation: fenceGeneration,
  leaseId: `lease-${turn}`,
  sessionId: `session-${turn}`,
  turnId: `turn-${turn}`,
});

const destinationOwnerId = "owner-2";
const destinationOwnerGeneration = "owner-generation-2";
const transferOperationId = digest("turn-state-owner-transfer-1");
const transferSessionId = "transfer-coordinator-session";
const transferTurnId = `owner-transfer:${transferOperationId}`;

const transferFence = (
  scopedOwnerId: string,
  scopedOwnerGeneration: string,
  side: "source" | "destination",
): TurnStateOwnerFence => {
  const generation = `transfer-${side}-generation`;
  const transferLease = {
    leaseId: `transfer-${side}-lease`,
    sessionId: transferSessionId,
    turnId: transferTurnId,
    ownerGeneration: scopedOwnerGeneration,
    namespace: "activity" as const,
    role: "transfer" as const,
    reservationGeneration: generation,
    expiresAt: 100_000,
  };
  return {
    ownerId: scopedOwnerId,
    generation,
    state: "open",
    active: { [transferLease.leaseId]: transferLease },
  };
};

const transferBody = (
  side: "source" | "destination",
): Record<string, unknown> => {
  const source = side === "source";
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    ownerId: source ? ownerId : destinationOwnerId,
    ownerGeneration: source ? ownerGeneration : destinationOwnerGeneration,
    generation: `transfer-${side}-generation`,
    leaseId: `transfer-${side}-lease`,
    sessionId: transferSessionId,
    turnId: transferTurnId,
    transferOperationId,
    fromOwnerId: ownerId,
    fromOwnerGeneration: ownerGeneration,
    toOwnerId: destinationOwnerId,
    toOwnerGeneration: destinationOwnerGeneration,
    sourceWorkspace: workspace,
    destinationWorkspace: workspace,
  };
};

const prepareBody = (
  turn: number,
  baseWorkspaceRevision = 0,
  scopedThreadId = threadId,
) => ({
  ...common(turn),
  workspace,
  threadId: scopedThreadId,
  attemptGeneration: 1,
  baseWorkspaceRevision,
  requestFingerprint: digest(`request-${turn}`),
  historyCursor: `cursor-${turn}`,
  createdAt: 1_000 + turn,
});

const request = (body: unknown, headers?: HeadersInit): Request =>
  new Request("https://build-session/owner-fence/turn-state", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const responseBody = async <T>(response: Response | null): Promise<T> => {
  expect(response).not.toBeNull();
  return (await response!.json()) as T;
};

const callRoute = async (args: {
  path: string;
  body: unknown;
  storage: FakeDurableObjectStorage;
  r2: FakeR2Bucket;
  fence: TurnStateOwnerFence;
  persistFence?: boolean;
  scopedOwnerId?: string;
  nativeIntegritySecret?: string;
}) => {
  if (args.persistFence !== false) {
    args.storage.set("ownerPurgeFence", args.fence);
  }
  return await handleTurnStateOwnerRoute({
    path: args.path,
    request: request(args.body),
    scopedOwnerId: args.scopedOwnerId ?? ownerId,
    fence: args.fence,
    storage: args.storage.asStorage(),
    bucket: args.r2.asBucket(),
    ...(args.nativeIntegritySecret
      ? { nativeIntegritySecret: args.nativeIntegritySecret }
      : {}),
    now: () => 10_000,
  });
};

const archive = (
  prepared: PreparedTurnStateOperation,
  kind: "workspace" | "native" = "workspace",
): TurnStateArchive => {
  const bytes = archiveBytes(kind);
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    kind,
    format: TURN_STATE_OBJECT_FORMAT,
    key: prepared.objectKeys[kind]!,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    etag: `etag-${prepared.operationId}-${kind}`,
    complete: true,
  };
};

const prepareAndCommit = async (
  storage: FakeDurableObjectStorage,
  r2: FakeR2Bucket,
  turn: number,
  options: {
    native?: boolean;
    baseWorkspaceRevision?: number;
    threadId?: string;
  } = {},
) => {
  const fence = openFence(turn);
  const scopedThreadId = options.threadId ?? threadId;
  const prepareResponse = await callRoute({
    path: "turn-state/prepare",
    body: {
      ...prepareBody(turn, options.baseWorkspaceRevision ?? 0, scopedThreadId),
      ...(options.native
        ? {
            nativeCheckpoint: signedNativeCheckpoint(
              turn,
              ownerId,
              ownerGeneration,
              scopedThreadId,
            ),
          }
        : {}),
    },
    storage,
    r2,
    fence,
  });
  expect(prepareResponse?.status).toBe(200);
  const prepared =
    await responseBody<PreparedTurnStateOperation>(prepareResponse);
  const descriptor = archive(prepared);
  r2.put(descriptor.key, descriptor.sizeBytes, descriptor.etag, descriptor);
  const uploaded = await callRoute({
    path: "turn-state/mark-uploaded",
    body: {
      ...common(turn),
      operationId: prepared.operationId,
      archive: descriptor,
    },
    storage,
    r2,
    fence,
  });
  expect(uploaded?.status).toBe(200);
  const nativeDescriptor = options.native
    ? archive(prepared, "native")
    : undefined;
  if (nativeDescriptor) {
    r2.put(
      nativeDescriptor.key,
      nativeDescriptor.sizeBytes,
      nativeDescriptor.etag,
      nativeDescriptor,
    );
    const nativeUploaded = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(turn),
        operationId: prepared.operationId,
        archive: nativeDescriptor,
      },
      storage,
      r2,
      fence,
    });
    expect(nativeUploaded?.status).toBe(200);
  }
  const committed = await callRoute({
    path: "turn-state/commit",
    body: { ...common(turn), operationId: prepared.operationId },
    storage,
    r2,
    fence,
  });
  expect(committed?.status).toBe(200);
  return { prepared, descriptor, nativeDescriptor, fence };
};

const publishPreparedWorkspace = async (
  storage: FakeDurableObjectStorage,
  r2: FakeR2Bucket,
  turn: number,
  operationId: string,
  fence: TurnStateOwnerFence,
  scopedThreadId = threadId,
) => {
  const response = await callRoute({
    path: "turn-state/publish-workspace",
    body: {
      ...common(turn),
      workspace,
      threadId: scopedThreadId,
      canonicalHistoryCursor: `cursor-${turn}`,
      operationId,
    },
    storage,
    r2,
    fence,
  });
  expect(response?.status).toBe(200);
  return await responseBody<{
    workspaceHead: { operationId: string };
    publicationReceipt: string;
    replayed: boolean;
  }>(response);
};

describe("turn-state owner routes", () => {
  test("adapts Durable Object and R2 pages without lexicographic skips", async () => {
    const rawStorage = new FakeDurableObjectStorage();
    rawStorage.set("turn-state:v1:test:c", { value: 3 });
    rawStorage.set("turn-state:v1:test:a", { value: 1 });
    rawStorage.set("turn-state:v1:test:b", { value: 2 });
    const storage = createDurableObjectTurnStateStorage(rawStorage.asStorage());
    const first = await storage.list<{ value: number }>({
      prefix: "turn-state:v1:test:",
      limit: 2,
    });
    expect([...first.keys()]).toEqual([
      "turn-state:v1:test:a",
      "turn-state:v1:test:b",
    ]);
    const second = await storage.list<{ value: number }>({
      prefix: "turn-state:v1:test:",
      startAfter: [...first.keys()].at(-1),
      limit: 2,
    });
    expect([...second.keys()]).toEqual(["turn-state:v1:test:c"]);
    expect(rawStorage.listCalls.at(-1)?.startAfter).toBe(
      "turn-state:v1:test:b",
    );

    const rawR2 = new FakeR2Bucket(1);
    const prefix = `stella-checkpoints/v1/${digest("owner")}/`;
    rawR2.put(`${prefix}b`, 2, "etag-b");
    rawR2.put(`${prefix}a`, 1, "etag-a");
    const r2 = createR2TurnStateObjectStore(rawR2.asBucket());
    const r2First = await r2.list(prefix);
    expect(r2First).toEqual({
      keys: [`${prefix}a`],
      cursor: `${prefix}a`,
      complete: false,
    });
    const r2Second = await r2.list(prefix, r2First.cursor);
    expect(r2Second).toEqual({ keys: [`${prefix}b`], complete: true });
    expect(await r2.head(`${prefix}b`)).toEqual({ size: 2, etag: "etag-b" });
  });

  test("accepts exact real workspace and native uploads after durable R2 HEAD proof", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const fence = openFence(1);
    const preparedResponse = await callRoute({
      path: "turn-state/prepare",
      body: {
        ...prepareBody(1),
        nativeCheckpoint: signedNativeCheckpoint(1),
      },
      storage,
      r2,
      fence,
    });
    expect(preparedResponse?.status).toBe(200);
    const prepared =
      await responseBody<PreparedTurnStateOperation>(preparedResponse);

    const workspaceUpload = await uploadTurnStateArchive({
      session: new RouteArchiveSession(archiveBytes("workspace")).asSession(),
      bucket: r2.asBucket(),
      key: prepared.objectKeys.workspace,
      target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
    });
    const nativeUpload = await uploadTurnStateArchive({
      session: new RouteArchiveSession(archiveBytes("native")).asSession(),
      bucket: r2.asBucket(),
      key: prepared.objectKeys.native!,
      target: { kind: "native" },
    });

    expect(
      await r2.asBucket().head(workspaceUpload.archive.key),
    ).not.toBeNull();
    expect(await r2.asBucket().head(nativeUpload.archive.key)).not.toBeNull();
    for (const uploaded of [workspaceUpload, nativeUpload]) {
      const marked = await callRoute({
        path: "turn-state/mark-uploaded",
        body: {
          ...common(1),
          operationId: prepared.operationId,
          archive: uploaded.archive,
        },
        storage,
        r2,
        fence,
      });
      expect(marked?.status).toBe(200);
      expect(await responseBody<{ replayed: boolean }>(marked)).toEqual({
        replayed: false,
      });
    }
  });

  test("fences prepare, upload, commit, resolve, and operation authorization to one exact lease", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const first = await prepareAndCommit(storage, r2, 1);

    const replay = await callRoute({
      path: "turn-state/commit",
      body: { ...common(1), operationId: first.prepared.operationId },
      storage,
      r2,
      fence: first.fence,
    });
    expect(replay?.status).toBe(200);
    expect(await responseBody<{ replayed: boolean }>(replay)).toMatchObject({
      replayed: true,
    });

    const replacementFence = openFence(2);
    const crossed = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(2),
        operationId: first.prepared.operationId,
        archive: first.descriptor,
      },
      storage,
      r2,
      fence: replacementFence,
    });
    expect(crossed?.status).toBe(409);
    expect(await responseBody<{ code: string }>(crossed)).toMatchObject({
      code: "operation_scope_mismatch",
    });

    const resolved = await callRoute({
      path: "turn-state/resolve",
      body: {
        ...common(1),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        requireNative: false,
      },
      storage,
      r2,
      fence: first.fence,
    });
    expect(resolved?.status).toBe(200);
    expect(
      await responseBody<{
        registryPresent: boolean;
        confirmationRequired: boolean;
        workspacePublication: { operationId: string; publishable: boolean };
      }>(resolved),
    ).toMatchObject({
      registryPresent: true,
      confirmationRequired: true,
      workspacePublication: {
        operationId: first.prepared.operationId,
        publishable: true,
      },
    });
    const published = await publishPreparedWorkspace(
      storage,
      r2,
      1,
      first.prepared.operationId,
      first.fence,
    );
    expect(published.replayed).toBe(false);
    const confirmed = await callRoute({
      path: "turn-state/confirm-restore",
      body: {
        ...common(1),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        workspaceOperationId: first.prepared.operationId,
        threadOperationId: first.prepared.operationId,
      },
      storage,
      r2,
      fence: first.fence,
    });
    expect(confirmed?.status).toBe(200);
    expect(
      await responseBody<{
        workspace: { promoted: boolean; replayed: boolean };
        thread: { promoted: boolean; replayed: boolean };
      }>(confirmed),
    ).toMatchObject({
      workspace: { promoted: true, replayed: false },
      thread: { promoted: true, replayed: false },
    });
  });

  test("aborts only the exact unpublished candidate and durably retires its archive pair", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const first = await prepareAndCommit(storage, r2, 1, { native: true });
    await publishPreparedWorkspace(
      storage,
      r2,
      1,
      first.prepared.operationId,
      first.fence,
    );
    const firstConfirmed = await callRoute({
      path: "turn-state/confirm-restore",
      body: {
        ...common(1),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        workspaceOperationId: first.prepared.operationId,
        threadOperationId: first.prepared.operationId,
      },
      storage,
      r2,
      fence: first.fence,
    });
    expect(firstConfirmed?.status).toBe(200);

    const unpublished = await prepareAndCommit(storage, r2, 2, {
      native: true,
      baseWorkspaceRevision: 1,
    });
    const recoveryFence = openFence(3);
    const abortBody = {
      ...common(3),
      workspace,
      threadId,
      operationId: unpublished.prepared.operationId,
      baseWorkspaceRevision: 1,
      candidateHistoryCursor: "cursor-2",
      canonicalHistoryCursor: "cursor-1",
    };
    const canonicalAbort = await callRoute({
      path: "turn-state/abort-unpublished",
      body: { ...abortBody, canonicalHistoryCursor: "cursor-2" },
      storage,
      r2,
      fence: recoveryFence,
    });
    expect(canonicalAbort?.status).toBe(409);
    expect(r2.keys()).toContain(unpublished.descriptor.key);
    expect(r2.keys()).toContain(unpublished.nativeDescriptor!.key);

    const abortedResponse = await callRoute({
      path: "turn-state/abort-unpublished",
      body: abortBody,
      storage,
      r2,
      fence: recoveryFence,
    });
    const aborted = await responseBody<{
      operationId: string;
      abortReceipt: string;
      replayed: boolean;
      error?: string;
      code?: string;
    }>(abortedResponse);
    expect(abortedResponse?.status).toBe(200);
    expect(aborted).toMatchObject({
      operationId: unpublished.prepared.operationId,
      replayed: false,
    });
    expect(aborted.abortReceipt).toMatch(/^[0-9a-f]{64}$/u);

    const replay = await callRoute({
      path: "turn-state/abort-unpublished",
      body: abortBody,
      storage,
      r2,
      fence: recoveryFence,
    });
    expect(replay?.status).toBe(200);
    expect(await responseBody(replay)).toMatchObject({
      abortReceipt: aborted.abortReceipt,
      replayed: true,
    });
    const retirement = storage.entries(
      `turn-state:v1:retirement:${unpublished.prepared.operationId}`,
    );
    expect([...retirement.values()].at(0)).toMatchObject({
      operationId: unpublished.prepared.operationId,
      objectKeys: [
        unpublished.descriptor.key,
        unpublished.nativeDescriptor!.key,
      ],
    });
    for (const descriptor of [
      unpublished.descriptor,
      unpublished.nativeDescriptor!,
    ]) {
      expect(
        storage
          .entries(`turn-state:v1:object:${descriptor.key}`)
          .get(`turn-state:v1:object:${descriptor.key}`),
      ).toMatchObject({ state: "retiring" });
    }

    const restored = await callRoute({
      path: "turn-state/resolve",
      body: {
        ...common(3),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        requireNative: true,
      },
      storage,
      r2,
      fence: recoveryFence,
    });
    expect(restored?.status).toBe(200);
    expect(await responseBody(restored)).toMatchObject({
      baseWorkspaceRevision: 1,
      workspace: { operationId: first.prepared.operationId },
      restore: { operationId: first.prepared.operationId },
    });

    let drained = await callRoute({
      path: "turn-state/drain",
      body: { ...common(3), workspace },
      storage,
      r2,
      fence: recoveryFence,
    });
    for (
      let attempt = 0;
      drained?.status === 202 && attempt < 4;
      attempt += 1
    ) {
      drained = await callRoute({
        path: "turn-state/drain",
        body: { ...common(3), workspace },
        storage,
        r2,
        fence: recoveryFence,
      });
    }
    expect(drained?.status).toBe(200);
    expect(r2.keys()).not.toContain(unpublished.descriptor.key);
    expect(r2.keys()).not.toContain(unpublished.nativeDescriptor!.key);
    expect(
      storage.entries(
        `turn-state:v1:route-operation:${unpublished.prepared.operationId}`,
      ).size,
    ).toBe(0);

    // Retirement cleanup removes the heavyweight operation/authorization but
    // preserves the compact abort tombstone for an arbitrarily late replay of
    // a response that the caller may never have received.
    const replayAfterDrain = await callRoute({
      path: "turn-state/abort-unpublished",
      body: abortBody,
      storage,
      r2,
      fence: recoveryFence,
    });
    expect(replayAfterDrain?.status).toBe(200);
    expect(await responseBody(replayAfterDrain)).toMatchObject({
      abortReceipt: aborted.abortReceipt,
      replayed: true,
    });

    // Removing the candidate unwedges the exact base revision for a fallback
    // checkpoint; neither the prior committed head nor native state moved.
    const fallbackPrepare = await callRoute({
      path: "turn-state/prepare",
      body: prepareBody(4, 1),
      storage,
      r2,
      fence: openFence(4),
    });
    expect(fallbackPrepare?.status).toBe(200);
  });

  test("adopts one deterministic legacy workspace seed across exact live leases and rejects source drift", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const requestFingerprint = digest("exact-legacy-directory-descriptor");
    const seedBody = (turn: number, fingerprint = requestFingerprint) => ({
      ...common(turn),
      workspace,
      requestFingerprint: fingerprint,
      createdAt: 777,
    });
    const firstFence = openFence(1);
    const firstResponse = await callRoute({
      path: "turn-state/legacy-seed-prepare",
      body: seedBody(1),
      storage,
      r2,
      fence: firstFence,
    });
    expect(firstResponse?.status).toBe(200);
    const first = await responseBody<PreparedTurnStateOperation>(firstResponse);

    const secondFence = openFence(2);
    const secondResponse = await callRoute({
      path: "turn-state/legacy-seed-prepare",
      body: seedBody(2),
      storage,
      r2,
      fence: secondFence,
    });
    expect(secondResponse?.status).toBe(200);
    const second =
      await responseBody<PreparedTurnStateOperation>(secondResponse);
    expect(second.operationId).toBe(first.operationId);
    expect(second.replayed).toBe(true);

    const descriptor = archive(second);
    r2.put(descriptor.key, descriptor.sizeBytes, descriptor.etag, descriptor);
    const staleLease = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(1),
        operationId: first.operationId,
        archive: descriptor,
      },
      storage,
      r2,
      fence: firstFence,
    });
    expect(staleLease?.status).toBe(409);
    const adoptedLease = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(2),
        operationId: second.operationId,
        archive: descriptor,
      },
      storage,
      r2,
      fence: secondFence,
    });
    expect(adoptedLease?.status).toBe(200);

    const changed = await callRoute({
      path: "turn-state/legacy-seed-prepare",
      body: seedBody(3, digest("different-legacy-directory-descriptor")),
      storage,
      r2,
      fence: openFence(3),
    });
    expect(changed?.status).toBe(409);
    expect(await responseBody<{ code: string }>(changed)).toMatchObject({
      code: "legacy_seed_conflict",
    });
  });

  test("binds transfer authority to the reservation generation across a later purge begin", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const original = transferFence(ownerId, ownerGeneration, "source");
    const staleGeneration = await callRoute({
      path: "turn-state/transfer-export",
      body: { ...transferBody("source"), generation: "not-the-reservation" },
      storage,
      r2,
      fence: original,
      nativeIntegritySecret,
    });
    expect(staleGeneration?.status).toBe(409);

    const blockedAfterReservation: TurnStateOwnerFence = {
      ...original,
      generation: "later-owner-purge-generation",
      state: "blocked",
    };
    const stillAuthorized = await callRoute({
      path: "turn-state/transfer-export",
      body: transferBody("source"),
      storage,
      r2,
      fence: blockedAfterReservation,
      nativeIntegritySecret,
    });
    expect(stillAuthorized?.status).toBe(200);
    expect(
      await responseBody<TurnStateTransferExportResponse>(stillAuthorized),
    ).toMatchObject({ manifest: { count: 0 }, entries: [] });
  });

  test.each(["drive", "stella"])(
    "allows a read-only %s fallback status probe without weakening mutating mount fences",
    async (sourceWorkspace) => {
      const destinationStorage = new FakeDurableObjectStorage();
      const r2 = new FakeR2Bucket();
      const destinationFence = transferFence(
        destinationOwnerId,
        destinationOwnerGeneration,
        "destination",
      );
      const crossMountBody = {
        ...transferBody("destination"),
        sourceWorkspace,
        destinationWorkspace: `project:import-${sourceWorkspace}`,
      };

      const status = await callRoute({
        path: "turn-state/transfer-status",
        body: crossMountBody,
        storage: destinationStorage,
        r2,
        fence: destinationFence,
        scopedOwnerId: destinationOwnerId,
      });
      expect(status?.status).toBe(200);
      expect(
        await responseBody<TurnStateTransferDestinationStatus>(status),
      ).toEqual({ state: "empty" });

      const sourceStorage = new FakeDurableObjectStorage();
      const exported = await callRoute({
        path: "turn-state/transfer-export",
        body: {
          ...transferBody("source"),
          sourceWorkspace,
          destinationWorkspace: `project:import-${sourceWorkspace}`,
        },
        storage: sourceStorage,
        r2,
        fence: transferFence(ownerId, ownerGeneration, "source"),
      });
      expect(exported?.status).toBe(400);
      expect(await responseBody(exported)).toMatchObject({
        code: "invalid_request",
      });
    },
  );

  test("transfers global workspace heads and per-thread native state before guarded source retirement", async () => {
    const sourceStorage = new FakeDurableObjectStorage();
    const destinationStorage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const secondThreadId = "thread-2";

    const publishAndConfirm = async (
      checkpoint: Awaited<ReturnType<typeof prepareAndCommit>>,
      turn: number,
      scopedThreadId: string,
    ) => {
      await publishPreparedWorkspace(
        sourceStorage,
        r2,
        turn,
        checkpoint.prepared.operationId,
        checkpoint.fence,
        scopedThreadId,
      );
      const confirmed = await callRoute({
        path: "turn-state/confirm-restore",
        body: {
          ...common(turn),
          workspace,
          threadId: scopedThreadId,
          canonicalHistoryCursor: `cursor-${turn}`,
          workspaceOperationId: checkpoint.prepared.operationId,
          threadOperationId: checkpoint.prepared.operationId,
        },
        storage: sourceStorage,
        r2,
        fence: checkpoint.fence,
      });
      expect(confirmed?.status).toBe(200);
    };

    const first = await prepareAndCommit(sourceStorage, r2, 1, {
      native: true,
    });
    await publishAndConfirm(first, 1, threadId);

    const second = await prepareAndCommit(sourceStorage, r2, 2, {
      native: true,
      baseWorkspaceRevision: 1,
      threadId: secondThreadId,
    });
    await publishAndConfirm(second, 2, secondThreadId);

    // The global workspace advanced in thread 2. Its predecessor is retired,
    // while thread 1 must retain only its still-canonical native continuation.
    const drained = await drainTurnStateRetirements(
      createDurableObjectTurnStateStorage(sourceStorage.asStorage()),
      createR2TurnStateObjectStore(r2.asBucket()),
      { ownerId, ownerGeneration, workspace },
    );
    expect(drained.completed).toBe(1);
    expect(r2.keys()).not.toContain(first.descriptor.key);
    expect(r2.keys()).toContain(first.nativeDescriptor!.key);

    // A third checkpoint is durable but not transcript-published/promoted.
    // Transfer must carry it as a candidate without making it globally visible.
    const third = await prepareAndCommit(sourceStorage, r2, 3, {
      native: true,
      baseWorkspaceRevision: 2,
      threadId,
    });

    const sourceTransferFence = transferFence(
      ownerId,
      ownerGeneration,
      "source",
    );
    const exportedResponse = await callRoute({
      path: "turn-state/transfer-export",
      body: transferBody("source"),
      storage: sourceStorage,
      r2,
      fence: sourceTransferFence,
      nativeIntegritySecret,
    });
    expect(exportedResponse?.status).toBe(200);
    const exported =
      await responseBody<TurnStateTransferExportResponse>(exportedResponse);
    expect(exported.manifest.count).toBe(5);
    expect(
      exported.entries.map((entry) =>
        entry.entryKind === "workspace"
          ? `workspace:${entry.disposition}`
          : `thread:${entry.threadId}:${entry.disposition}`,
      ),
    ).toEqual([
      "workspace:committed",
      "workspace:candidate",
      "thread:thread-1:committed",
      "thread:thread-1:candidate",
      "thread:thread-2:committed",
    ]);

    const destinationTransferFence = transferFence(
      destinationOwnerId,
      destinationOwnerGeneration,
      "destination",
    );
    const destinationStatus = async (
      storage: FakeDurableObjectStorage,
    ): Promise<TurnStateTransferDestinationStatus> => {
      const response = await callRoute({
        path: "turn-state/transfer-status",
        body: transferBody("destination"),
        storage,
        r2,
        fence: destinationTransferFence,
        scopedOwnerId: destinationOwnerId,
        nativeIntegritySecret,
      });
      expect(response?.status).toBe(200);
      return await responseBody<TurnStateTransferDestinationStatus>(response);
    };
    expect(await destinationStatus(destinationStorage)).toEqual({
      state: "empty",
    });
    const conflictedDestinationStorage = new FakeDurableObjectStorage();
    const destinationWorkspaceHash = digest(workspace);
    conflictedDestinationStorage.set(
      `turn-state:v1:operation:${digest("unrelated-destination-operation")}`,
      {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: digest(destinationOwnerId),
        ownerGeneration: destinationOwnerGeneration,
        workspaceHash: destinationWorkspaceHash,
        operationId: digest("unrelated-destination-operation"),
      },
    );
    expect(await destinationStatus(conflictedDestinationStorage)).toEqual({
      state: "occupied",
    });
    const conflictedStage = await callRoute({
      path: "turn-state/transfer-stage",
      body: {
        ...transferBody("destination"),
        manifest: exported.manifest,
        entry: exported.entries[0],
      },
      storage: conflictedDestinationStorage,
      r2,
      fence: destinationTransferFence,
      scopedOwnerId: destinationOwnerId,
      nativeIntegritySecret,
    });
    expect(conflictedStage?.status).toBe(409);
    expect(await responseBody(conflictedStage)).toMatchObject({
      code: "turn_state_transfer_destination_conflict",
    });

    const stage = async (
      entry: TurnStateTransferExportResponse["entries"][number],
    ) => {
      const response = await callRoute({
        path: "turn-state/transfer-stage",
        body: {
          ...transferBody("destination"),
          manifest: exported.manifest,
          entry,
        },
        storage: destinationStorage,
        r2,
        fence: destinationTransferFence,
        scopedOwnerId: destinationOwnerId,
        nativeIntegritySecret,
      });
      expect(response?.status).toBe(200);
      return await responseBody<{ replayed: boolean }>(response);
    };

    expect((await stage(exported.entries[0]!)).replayed).toBe(false);
    expect(await destinationStatus(destinationStorage)).toEqual({
      state: "staging",
    });
    const incompleteActivation = await callRoute({
      path: "turn-state/transfer-activate",
      body: {
        ...transferBody("destination"),
        manifest: exported.manifest,
      },
      storage: destinationStorage,
      r2,
      fence: destinationTransferFence,
      scopedOwnerId: destinationOwnerId,
      nativeIntegritySecret,
    });
    expect(incompleteActivation?.status).toBe(409);
    // Replaying after a lost stage response must reuse the exact copied bytes.
    expect((await stage(exported.entries[0]!)).replayed).toBe(true);
    for (const entry of exported.entries.slice(1)) await stage(entry);

    const activate = async () => {
      const response = await callRoute({
        path: "turn-state/transfer-activate",
        body: {
          ...transferBody("destination"),
          manifest: exported.manifest,
        },
        storage: destinationStorage,
        r2,
        fence: destinationTransferFence,
        scopedOwnerId: destinationOwnerId,
        nativeIntegritySecret,
      });
      expect(response?.status).toBe(200);
      return await responseBody<TurnStateTransferActivationResponse>(response);
    };
    const activated = await activate();
    expect(activated).toMatchObject({ count: 5, replayed: false });
    expect(await destinationStatus(destinationStorage)).toEqual({
      state: "activated",
      activationReceipt: activated.activationReceipt,
    });
    expect(await activate()).toMatchObject({
      activationReceipt: activated.activationReceipt,
      replayed: true,
    });

    // A transferred candidate remains an abortable, exact registry operation.
    // Clone the strong destination state so the main branch can separately
    // prove publication/promotion without sharing mutated DO metadata.
    const abortDestinationStorage = new FakeDurableObjectStorage();
    for (const [key, value] of destinationStorage.entries()) {
      abortDestinationStorage.set(key, value);
    }
    const abortRunFence = openFenceFor(
      destinationOwnerId,
      destinationOwnerGeneration,
      19,
    );
    const abortCommon = commonFor(
      destinationOwnerId,
      destinationOwnerGeneration,
      19,
    );
    const abortProbeResponse = await callRoute({
      path: "turn-state/resolve",
      body: {
        ...abortCommon,
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-3",
        requireNative: true,
      },
      storage: abortDestinationStorage,
      r2,
      fence: abortRunFence,
      scopedOwnerId: destinationOwnerId,
    });
    expect(abortProbeResponse?.status).toBe(200);
    const abortProbe = await responseBody<{
      baseWorkspaceRevision: number;
      workspacePublication: { operationId: string; publishable: boolean };
      restore: { native: TurnStateArchive };
    }>(abortProbeResponse);
    const transferredWorkspaceRecord = [
      ...abortDestinationStorage
        .entries(`turn-state:v1:workspace:${destinationWorkspaceHash}`)
        .values(),
    ][0] as { candidate: { archive: TurnStateArchive } };
    expect(
      abortDestinationStorage.entries(
        `turn-state:v1:operation:${abortProbe.workspacePublication.operationId}`,
      ).size,
    ).toBe(1);
    const abortTransferred = await callRoute({
      path: "turn-state/abort-unpublished",
      body: {
        ...abortCommon,
        workspace,
        threadId,
        operationId: abortProbe.workspacePublication.operationId,
        baseWorkspaceRevision: abortProbe.baseWorkspaceRevision,
        candidateHistoryCursor: "cursor-3",
        canonicalHistoryCursor: "cursor-2",
      },
      storage: abortDestinationStorage,
      r2,
      fence: abortRunFence,
      scopedOwnerId: destinationOwnerId,
    });
    expect(abortTransferred?.status).toBe(200);
    const transferredRetirement = abortDestinationStorage.entries(
      `turn-state:v1:retirement:${abortProbe.workspacePublication.operationId}`,
    );
    expect(transferredRetirement.size).toBe(1);
    expect([...transferredRetirement.values()][0]).toMatchObject({
      objectKeys: [
        transferredWorkspaceRecord.candidate.archive.key,
        abortProbe.restore.native.key,
      ],
    });

    const sourcePrefix = `${TURN_STATE_OBJECT_PREFIX}/${digest(ownerId)}/${digest(workspace)}/`;
    const destinationPrefix = `${TURN_STATE_OBJECT_PREFIX}/${digest(destinationOwnerId)}/${digest(workspace)}/`;
    expect(r2.keys(sourcePrefix)).toHaveLength(5);
    expect(r2.keys(destinationPrefix)).toHaveLength(5);

    const destinationRunFence = openFenceFor(
      destinationOwnerId,
      destinationOwnerGeneration,
      20,
    );
    const destinationCommon = commonFor(
      destinationOwnerId,
      destinationOwnerGeneration,
      20,
    );
    const resolveDestination = async (
      scopedThreadId: string,
      cursor: string,
    ) => {
      const response = await callRoute({
        path: "turn-state/resolve",
        body: {
          ...destinationCommon,
          workspace,
          threadId: scopedThreadId,
          canonicalHistoryCursor: cursor,
          requireNative: true,
        },
        storage: destinationStorage,
        r2,
        fence: destinationRunFence,
        scopedOwnerId: destinationOwnerId,
      });
      expect(response?.status).toBe(200);
      return await responseBody<{
        baseWorkspaceRevision: number;
        workspace?: { operationId: string; archive: TurnStateArchive };
        workspacePublication?: { operationId: string; publishable: boolean };
        restore?: {
          operationId: string;
          historyCursor: string;
          native?: TurnStateArchive;
          nativeCheckpoint?: TurnStateNativeCheckpoint;
        };
      }>(response);
    };

    const pending = await resolveDestination(threadId, "cursor-3");
    expect(pending).toMatchObject({
      baseWorkspaceRevision: 2,
      workspacePublication: { publishable: true },
      restore: { historyCursor: "cursor-3" },
    });
    expect(pending.workspace?.operationId).not.toBe(
      pending.workspacePublication?.operationId,
    );
    expect(
      await validNativeStateCheckpointMac({
        checkpoint: pending.restore!.nativeCheckpoint!,
        threadId,
        integrityKey: integrityKey(
          destinationOwnerId,
          destinationOwnerGeneration,
          threadId,
        ),
      }),
    ).toBe(true);

    const publishDestination = await callRoute({
      path: "turn-state/publish-workspace",
      body: {
        ...destinationCommon,
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-3",
        operationId: pending.workspacePublication!.operationId,
      },
      storage: destinationStorage,
      r2,
      fence: destinationRunFence,
      scopedOwnerId: destinationOwnerId,
    });
    expect(publishDestination?.status).toBe(200);
    const published = await resolveDestination(threadId, "cursor-3");
    expect(published.workspace?.operationId).toBe(
      published.restore?.operationId,
    );

    const destinationConfirmed = await callRoute({
      path: "turn-state/confirm-restore",
      body: {
        ...destinationCommon,
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-3",
        workspaceOperationId: published.workspace!.operationId,
        threadOperationId: published.restore!.operationId,
      },
      storage: destinationStorage,
      r2,
      fence: destinationRunFence,
      scopedOwnerId: destinationOwnerId,
    });
    expect(destinationConfirmed?.status).toBe(200);

    const secondThreadRestore = await resolveDestination(
      secondThreadId,
      "cursor-2",
    );
    expect(secondThreadRestore).toMatchObject({
      baseWorkspaceRevision: 3,
      workspace: { operationId: published.workspace!.operationId },
      restore: { historyCursor: "cursor-2" },
    });
    expect(
      await validNativeStateCheckpointMac({
        checkpoint: secondThreadRestore.restore!.nativeCheckpoint!,
        threadId: secondThreadId,
        integrityKey: integrityKey(
          destinationOwnerId,
          destinationOwnerGeneration,
          secondThreadId,
        ),
      }),
    ).toBe(true);

    const sourceKeysBeforeTamper = r2.keys(sourcePrefix);
    const badReceipt =
      activated.activationReceipt === "0".repeat(64)
        ? "1".repeat(64)
        : "0".repeat(64);
    const tamperedRetire = await callRoute({
      path: "turn-state/transfer-retire",
      body: {
        ...transferBody("source"),
        manifest: exported.manifest,
        activationReceipt: badReceipt,
      },
      storage: sourceStorage,
      r2,
      fence: sourceTransferFence,
      nativeIntegritySecret,
    });
    expect(tamperedRetire?.status).toBe(409);
    expect(r2.keys(sourcePrefix)).toEqual(sourceKeysBeforeTamper);

    const firstRetirePass = await callRoute({
      path: "turn-state/transfer-retire",
      body: {
        ...transferBody("source"),
        manifest: exported.manifest,
        activationReceipt: activated.activationReceipt,
      },
      storage: sourceStorage,
      r2,
      fence: sourceTransferFence,
      nativeIntegritySecret,
    });
    expect(firstRetirePass?.status).toBe(202);
    expect(await responseBody(firstRetirePass)).toMatchObject({
      pending: true,
    });

    let sourceEmptyScans = 0;
    r2.onList = (options) => {
      if (options.prefix !== sourcePrefix) return;
      sourceEmptyScans += 1;
      if (sourceEmptyScans !== 3) return;
      const active = sourceTransferFence.active["transfer-source-lease"]!;
      sourceStorage.set("ownerPurgeFence", {
        ...sourceTransferFence,
        active: {
          [active.leaseId]: { ...active, expiresAt: 5_000 },
        },
      } satisfies TurnStateOwnerFence);
    };
    const expiredAfterScan = await callRoute({
      path: "turn-state/transfer-retire",
      body: {
        ...transferBody("source"),
        manifest: exported.manifest,
        activationReceipt: activated.activationReceipt,
      },
      storage: sourceStorage,
      r2,
      fence: sourceTransferFence,
      nativeIntegritySecret,
    });
    expect(sourceEmptyScans).toBe(3);
    expect(expiredAfterScan?.status).toBe(409);
    expect(await responseBody(expiredAfterScan)).toMatchObject({
      code: "owner_transfer_fence_changed",
    });
    r2.onList = undefined;

    const retire = async () => {
      const response = await callRoute({
        path: "turn-state/transfer-retire",
        body: {
          ...transferBody("source"),
          manifest: exported.manifest,
          activationReceipt: activated.activationReceipt,
        },
        storage: sourceStorage,
        r2,
        fence: sourceTransferFence,
        nativeIntegritySecret,
      });
      expect([200, 202]).toContain(response?.status);
      const body = await responseBody<{
        pending: boolean;
        emptyReceipt?: string;
      }>(response);
      expect(response?.status).toBe(body.pending ? 202 : 200);
      return body;
    };
    let retired = await retire();
    for (let attempt = 0; retired.pending && attempt < 4; attempt += 1) {
      retired = await retire();
    }
    expect(retired.pending).toBe(false);
    expect(retired.emptyReceipt).toMatch(/^[0-9a-f]{64}$/u);
    expect(r2.keys(sourcePrefix)).toEqual([]);
    expect(r2.keys(destinationPrefix)).toHaveLength(5);
    expect(await retire()).toMatchObject({
      pending: false,
      emptyReceipt: retired.emptyReceipt,
    });
  });

  test("refuses to mark an R2 object without the exact checksum and archive metadata", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const fence = openFence(1);
    const preparedResponse = await callRoute({
      path: "turn-state/prepare",
      body: prepareBody(1),
      storage,
      r2,
      fence,
    });
    const prepared =
      await responseBody<PreparedTurnStateOperation>(preparedResponse);
    const descriptor = archive(prepared);
    // Same key/size/ETag, but no Stella metadata and a different service-side
    // checksum: descriptor-only proof must never move the reservation forward.
    r2.put(descriptor.key, descriptor.sizeBytes, descriptor.etag);
    const response = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(1),
        operationId: prepared.operationId,
        archive: descriptor,
      },
      storage,
      r2,
      fence,
    });
    expect(response?.status).toBe(409);
    expect(await responseBody<{ code: string }>(response)).toMatchObject({
      code: "archive_not_durable",
    });
  });

  test("rechecks the durable open lease in the same transaction after R2 HEAD", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const staleSnapshot = openFence(1);
    const prepared = await responseBody<PreparedTurnStateOperation>(
      await callRoute({
        path: "turn-state/prepare",
        body: prepareBody(1),
        storage,
        r2,
        fence: staleSnapshot,
      }),
    );
    const descriptor = archive(prepared);
    r2.put(descriptor.key, descriptor.sizeBytes, descriptor.etag, descriptor);
    storage.set("ownerPurgeFence", {
      ownerId,
      generation: "blocked-after-upload",
      state: "blocked",
      active: {},
    } satisfies TurnStateOwnerFence);

    const response = await callRoute({
      path: "turn-state/mark-uploaded",
      body: {
        ...common(1),
        operationId: prepared.operationId,
        archive: descriptor,
      },
      storage,
      r2,
      fence: staleSnapshot,
      persistFence: false,
    });
    expect(response?.status).toBe(409);
    expect(await responseBody<{ code: string }>(response)).toMatchObject({
      code: "owner_fence_changed",
    });
    const objectRecord = [
      ...storage.entries("turn-state:v1:object:").values(),
    ].at(0) as { state?: string };
    expect(objectRecord.state).toBe("reserved");
  });

  test("drain removes leaked route authorization on retry after registry cleanup response loss", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const first = await prepareAndCommit(storage, r2, 1);
    const firstProbe = await callRoute({
      path: "turn-state/resolve",
      body: {
        ...common(1),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        requireNative: false,
      },
      storage,
      r2,
      fence: first.fence,
    });
    expect(firstProbe?.status).toBe(200);
    await publishPreparedWorkspace(
      storage,
      r2,
      1,
      first.prepared.operationId,
      first.fence,
    );
    const firstConfirmed = await callRoute({
      path: "turn-state/confirm-restore",
      body: {
        ...common(1),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-1",
        workspaceOperationId: first.prepared.operationId,
        threadOperationId: first.prepared.operationId,
      },
      storage,
      r2,
      fence: first.fence,
    });
    expect(firstConfirmed?.status).toBe(200);
    const second = await prepareAndCommit(storage, r2, 2, {
      baseWorkspaceRevision: 1,
    });

    const resolved = await callRoute({
      path: "turn-state/resolve",
      body: {
        ...common(2),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-2",
        requireNative: false,
      },
      storage,
      r2,
      fence: second.fence,
    });
    expect(resolved?.status).toBe(200);
    await publishPreparedWorkspace(
      storage,
      r2,
      2,
      second.prepared.operationId,
      second.fence,
    );
    const confirmed = await callRoute({
      path: "turn-state/confirm-restore",
      body: {
        ...common(2),
        workspace,
        threadId,
        canonicalHistoryCursor: "cursor-2",
        workspaceOperationId: second.prepared.operationId,
        threadOperationId: second.prepared.operationId,
      },
      storage,
      r2,
      fence: second.fence,
    });
    expect(confirmed?.status).toBe(200);

    // Simulate a lost response after the registry drain committed but before
    // the owner-route authorization cleanup ran.
    const registryDrain = await drainTurnStateRetirements(
      createDurableObjectTurnStateStorage(storage.asStorage()),
      createR2TurnStateObjectStore(r2.asBucket()),
      { ownerId, ownerGeneration, workspace },
    );
    expect(registryDrain.completed).toBe(1);
    const authorizationPrefix = "turn-state:v1:route-operation:";
    expect(
      storage
        .entries(authorizationPrefix)
        .has(`${authorizationPrefix}${first.prepared.operationId}`),
    ).toBe(true);

    const retry = await callRoute({
      path: "turn-state/drain",
      body: { ...common(2), workspace },
      storage,
      r2,
      fence: second.fence,
    });
    expect(retry?.status).toBe(200);
    expect(await responseBody<{ completed: number }>(retry)).toMatchObject({
      completed: 0,
    });
    const authorizations = storage.entries(authorizationPrefix);
    expect(
      authorizations.has(`${authorizationPrefix}${first.prepared.operationId}`),
    ).toBe(false);
    expect(
      authorizations.has(
        `${authorizationPrefix}${second.prepared.operationId}`,
      ),
    ).toBe(true);
    expect(r2.keys()).not.toContain(first.descriptor.key);
    expect(r2.keys()).toContain(second.descriptor.key);
  });

  test("requires the exact drained blocked generation and purges full scoped registry and R2 prefixes", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket(1);
    const ownerHash = digest(ownerId);
    const workspaceHash = digest(workspace);
    const prefix = `stella-checkpoints/v1/${ownerHash}/${workspaceHash}/`;
    const orphan = `${prefix}orphan/workspace.sqsh`;
    r2.put(orphan, 3, "orphan-etag");
    storage.set("turn-state:v1:route-operation:metadata-only", {
      ownerHash,
      ownerGeneration,
      workspaceHash,
    });
    const blocked: TurnStateOwnerFence = {
      ownerId,
      generation: "purge-generation-1",
      state: "blocked",
      active: {},
    };

    const notEmpty = await callRoute({
      path: "turn-state/transfer-empty",
      body: {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerId,
        generation: blocked.generation,
        workspace,
      },
      storage,
      r2,
      fence: blocked,
    });
    expect(notEmpty?.status).toBe(409);

    const purged = await callRoute({
      path: "turn-state/purge",
      body: {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerId,
        generation: blocked.generation,
        workspace,
      },
      storage,
      r2,
      fence: blocked,
    });
    expect(purged?.status).toBe(200);
    expect(
      await responseBody<{ pending: boolean; prefix: string }>(purged),
    ).toMatchObject({
      pending: false,
      prefix,
    });
    expect(r2.keys(prefix)).toEqual([]);
    expect(storage.entries("turn-state:v1:route-operation:").size).toBe(0);

    const empty = await callRoute({
      path: "turn-state/transfer-empty",
      body: {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerId,
        generation: blocked.generation,
        workspace,
      },
      storage,
      r2,
      fence: blocked,
    });
    expect(empty?.status).toBe(200);
    expect(await responseBody<{ receipt: string }>(empty)).toMatchObject({
      receipt: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const activeBlocked = {
      ...blocked,
      active: { [lease(3).leaseId]: lease(3) },
    } satisfies TurnStateOwnerFence;
    const unsafe = await callRoute({
      path: "turn-state/purge",
      body: {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerId,
        generation: blocked.generation,
      },
      storage,
      r2,
      fence: activeBlocked,
    });
    expect(unsafe?.status).toBe(409);
  });

  test("purges one workspace through an exact open activity lease without a whole-owner fence", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const ownerHash = digest(ownerId);
    const workspaceHash = digest(workspace);
    const prefix = `stella-checkpoints/v1/${ownerHash}/${workspaceHash}/`;
    r2.put(`${prefix}orphan/workspace.sqsh`, 3, "orphan-etag");
    storage.set("turn-state:v1:route-operation:workspace-purge", {
      ownerHash,
      ownerGeneration,
      workspaceHash,
    });
    const activityLease = {
      leaseId: "workspace-purge-lease",
      sessionId: "activity-workspace-purge",
      turnId: "workspace-purge",
      ownerGeneration,
      namespace: "activity" as const,
      role: "run" as const,
      workspace,
      expiresAt: 20_000,
    };
    const fence: TurnStateOwnerFence = {
      ownerId,
      generation: fenceGeneration,
      state: "open",
      active: { [activityLease.leaseId]: activityLease },
    };
    const body = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerId,
      ownerGeneration,
      generation: fenceGeneration,
      leaseId: activityLease.leaseId,
      sessionId: activityLease.sessionId,
      turnId: activityLease.turnId,
      workspace,
    };
    const purged = await callRoute({
      path: "turn-state/purge-workspace",
      body,
      storage,
      r2,
      fence,
    });
    expect(purged?.status).toBe(200);
    expect(await responseBody(purged)).toMatchObject({
      pending: false,
      prefix,
    });
    expect(r2.keys(prefix)).toEqual([]);
    expect(storage.entries("turn-state:v1:route-operation:").size).toBe(0);

    const wrongLease = await callRoute({
      path: "turn-state/purge-workspace",
      body: { ...body, leaseId: "different-lease" },
      storage,
      r2,
      fence,
    });
    expect(wrongLease?.status).toBe(409);
  });

  test("rejects malformed, oversized, and stale-fence request bodies", async () => {
    const storage = new FakeDurableObjectStorage();
    const r2 = new FakeR2Bucket();
    const fence = openFence(1);

    const extra = await callRoute({
      path: "turn-state/prepare",
      body: { ...prepareBody(1), surprise: true },
      storage,
      r2,
      fence,
    });
    expect(extra?.status).toBe(400);

    const stale = await callRoute({
      path: "turn-state/prepare",
      body: { ...prepareBody(1), generation: "stale-generation" },
      storage,
      r2,
      fence,
    });
    expect(stale?.status).toBe(409);

    const oversizedNativeTree = signedNativeCheckpoint(1);
    oversizedNativeTree.tree.bytes = TURN_STATE_MAX_ARCHIVE_BYTES + 1;
    const outOfContractArchive = await callRoute({
      path: "turn-state/prepare",
      body: {
        ...prepareBody(1),
        nativeCheckpoint: oversizedNativeTree,
      },
      storage,
      r2,
      fence,
    });
    expect(outOfContractArchive?.status).toBe(400);

    const wrongOwner = await handleTurnStateOwnerRoute({
      path: "turn-state/prepare",
      request: request({ ...prepareBody(1), ownerId: "owner-2" }),
      scopedOwnerId: ownerId,
      fence,
      storage: storage.asStorage(),
      bucket: r2.asBucket(),
    });
    expect(wrongOwner?.status).toBe(409);

    const missingType = await handleTurnStateOwnerRoute({
      path: "turn-state/prepare",
      request: new Request("https://build-session/owner-fence/turn-state", {
        method: "POST",
        body: JSON.stringify(prepareBody(1)),
      }),
      scopedOwnerId: ownerId,
      fence,
      storage: storage.asStorage(),
      bucket: r2.asBucket(),
    });
    expect(missingType?.status).toBe(415);

    const oversized = await callRoute({
      path: "turn-state/prepare",
      body: { ...prepareBody(1), padding: "x".repeat(70_000) },
      storage,
      r2,
      fence,
    });
    expect(oversized?.status).toBe(413);

    expect(
      await handleTurnStateOwnerRoute({
        path: "register",
        request: request({}),
        scopedOwnerId: ownerId,
        fence,
        storage: storage.asStorage(),
        bucket: r2.asBucket(),
      }),
    ).toBeNull();
  });
});
