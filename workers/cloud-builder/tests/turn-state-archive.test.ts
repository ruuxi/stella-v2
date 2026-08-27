import { describe, expect, test } from "bun:test";
import { sha256BytesHex } from "../src/hash.js";
import {
  copyTurnStateArchive,
  copyTurnStateArchivePair,
  restoreTurnStateArchive,
  TURN_STATE_MAX_ARCHIVE_BYTES,
  type TurnStateArchiveSession,
  turnStateArchiveMetadata,
  turnStateArchiveMetadataMatches,
  uploadTurnStateArchive,
} from "../src/turn-state-archive.js";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_OBJECT_PREFIX,
  TURN_STATE_SCHEMA_VERSION,
  type TurnStateArchive,
  type TurnStateObjectKind,
} from "../src/turn-state-registry.js";

const encoder = new TextEncoder();

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
          controller.error(new Error("fixed stream ended at the wrong length"));
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

const archiveKey = (
  kind: TurnStateObjectKind,
  operationByte = "e",
  ownerByte = "a",
  workspaceByte = "b",
): string =>
  `${TURN_STATE_OBJECT_PREFIX}/${ownerByte.repeat(64)}/${workspaceByte.repeat(64)}/${"c".repeat(64)}/${"d".repeat(64)}/1-${operationByte.repeat(64)}/${kind}.sqsh`;

const byteStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });

const collect = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
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

const hex = (value: ArrayBuffer): string =>
  Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

class FakeClaimManager {
  readonly claims = new Map<string, string>();
  readonly stale = new Set<string>();

  expireAll(): void {
    for (const path of this.claims.keys()) this.stale.add(path);
  }
}

class FakeArchiveSession {
  readonly commands: string[] = [];
  readonly writes = new Map<string, Uint8Array>();
  restoreCalls = 0;
  reportedSize?: number;
  reportedReadSize?: number;
  beforeRead?: () => Promise<void>;
  failCleanupOnce = false;
  failWriteBeforeRead = false;
  failHeartbeatOnce = false;
  readCancelCalls = 0;

  constructor(
    readonly archiveBytes: Uint8Array,
    private readonly claimManager = new FakeClaimManager(),
  ) {}

  async exec(command: string): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    duration: number;
    timestamp: string;
  }> {
    this.commands.push(command);
    const failed = (stderr: string) => ({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr,
      command,
      duration: 1,
      timestamp: new Date(0).toISOString(),
    });
    const claimCreation =
      /printf '%s\\n' ([0-9a-f]{64}) > (\/home\/stella-host-state\/turn-state-archive\/claim-[a-z-]+)/u.exec(
        command,
      );
    if (claimCreation) {
      const [, scratchId, claimPath] = claimCreation;
      if (
        this.claimManager.claims.has(claimPath!) &&
        !this.claimManager.stale.delete(claimPath!)
      ) {
        return failed("fake scratch claim is busy");
      }
      this.claimManager.claims.set(claimPath!, scratchId!);
    }
    const claimOwnership =
      /\/usr\/bin\/cat -- (\/home\/stella-host-state\/turn-state-archive\/claim-[a-z-]+)\)" = ([0-9a-f]{64})/u.exec(
        command,
      );
    const releasesClaim = command.includes("then /usr/bin/rm -f --");
    if (
      this.failHeartbeatOnce &&
      command.includes("/usr/bin/touch --") &&
      !releasesClaim
    ) {
      this.failHeartbeatOnce = false;
      return failed("simulated heartbeat failure");
    }
    if (claimOwnership && !releasesClaim) {
      const [, claimPath, scratchId] = claimOwnership;
      if (this.claimManager.claims.get(claimPath!) !== scratchId) {
        return failed("fake scratch claim ownership changed");
      }
    }
    if (this.failCleanupOnce) {
      const isCleanup = Boolean(claimOwnership && releasesClaim);
      if (isCleanup) {
        this.failCleanupOnce = false;
        return failed("simulated cleanup failure");
      }
    }
    let stdout = "";
    if (command.includes("mksquashfs ")) {
      stdout = await this.digestOutput(
        this.archiveBytes,
        this.reportedSize ?? this.archiveBytes.byteLength,
      );
    } else if (command.includes("sha256sum -- ")) {
      const archivePath =
        /sha256sum -- (\/home\/stella-host-state\/turn-state-archive\/[a-z0-9-]+\.sqsh)/u.exec(
          command,
        )?.[1];
      if (!archivePath) throw new Error("fake did not find archive path");
      const bytes = this.writes.get(archivePath) ?? new Uint8Array();
      stdout = await this.digestOutput(bytes, bytes.byteLength);
    }
    if (command.includes("unsquashfs ")) this.restoreCalls += 1;
    const result = {
      success: true,
      exitCode: 0,
      stdout,
      stderr: "",
      command,
      duration: 1,
      timestamp: new Date(0).toISOString(),
    };
    if (claimOwnership && releasesClaim) {
      const [, claimPath, scratchId] = claimOwnership;
      if (this.claimManager.claims.get(claimPath!) === scratchId) {
        this.claimManager.claims.delete(claimPath!);
        this.claimManager.stale.delete(claimPath!);
      }
    }
    return result;
  }

  async readFile(path: string): Promise<{
    success: true;
    path: string;
    content: ReadableStream<Uint8Array>;
    size: number;
    mimeType: string;
    timestamp: string;
  }> {
    await this.beforeRead?.();
    if (this.reportedReadSize !== undefined) {
      return {
        success: true,
        path,
        content: new ReadableStream<Uint8Array>({
          cancel: () => {
            this.readCancelCalls += 1;
          },
        }),
        size: this.reportedReadSize,
        mimeType: "application/vnd.squashfs",
        timestamp: new Date(0).toISOString(),
      };
    }
    return {
      success: true,
      path,
      content: byteStream(this.archiveBytes),
      size: this.archiveBytes.byteLength,
      mimeType: "application/vnd.squashfs",
      timestamp: new Date(0).toISOString(),
    };
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    if (this.failWriteBeforeRead) {
      return {
        success: false,
        path,
        bytesWritten: 0,
        timestamp: new Date(0).toISOString(),
      };
    }
    const bytes =
      typeof content === "string"
        ? encoder.encode(content)
        : await collect(content);
    this.writes.set(path, bytes);
    return {
      success: true,
      path,
      bytesWritten: bytes.byteLength,
      timestamp: new Date(0).toISOString(),
    };
  }

  private async digestOutput(bytes: Uint8Array, size: number): Promise<string> {
    return `STELLA_ARCHIVE_SIZE=${size}\nSTELLA_ARCHIVE_SHA256=${await sha256BytesHex(bytes)}\n`;
  }

  asSession(): TurnStateArchiveSession {
    return this as unknown as TurnStateArchiveSession;
  }
}

type SwapFailureBoundary =
  | "source-to-prior"
  | "stage-to-source"
  | "prior-to-retired"
  | "retired-delete";

class SwapStateArchiveSession extends FakeArchiveSession {
  source: "old" | "new" | undefined = "old";
  prior: "old" | "new" | undefined;
  retired: "old" | "new" | undefined;
  readonly stages = new Map<string, "new">();
  private injected = false;

  constructor(
    bytes: Uint8Array,
    private readonly failAt: SwapFailureBoundary,
  ) {
    super(bytes);
  }

  override async exec(
    command: string,
  ): Promise<Awaited<ReturnType<FakeArchiveSession["exec"]>>> {
    const result = await super.exec(command);
    if (!result.success) return result;

    const extracted =
      /\/usr\/bin\/unsquashfs [^\n]* -d (\/workspace\/\.stella-turn-state-restore-workspace-drive-[0-9a-f]{64}) /u.exec(
        command,
      )?.[1];
    if (extracted) this.stages.set(extracted, "new");

    for (const match of command.matchAll(
      /\/usr\/bin\/rm -rf -- (\/workspace\/\.stella-turn-state-restore-workspace-drive-[0-9a-f]{64})/gu,
    )) {
      this.stages.delete(match[1]!);
    }

    const stage =
      /\/usr\/bin\/mv -- (\/workspace\/\.stella-turn-state-restore-workspace-drive-[0-9a-f]{64}) \/workspace\/drive/u.exec(
        command,
      )?.[1];
    if (!stage) return result;

    // Interpret the fixed-path recovery prelude before the new four-boundary
    // swap, so a second helper call exercises the real retry state machine.
    if (this.prior) {
      this.retired = undefined;
      if (this.source) this.retired = this.source;
      this.source = this.prior;
      this.prior = undefined;
      this.retired = undefined;
    } else if (this.retired) {
      if (!this.source)
        throw new Error("fake recovery lost every complete tree");
      this.retired = undefined;
    }
    if (!this.stages.has(stage)) {
      throw new Error("fake swap stage is missing");
    }

    if (this.source) {
      this.prior = this.source;
      this.source = undefined;
    }
    if (this.fail("source-to-prior")) return this.failed(result);

    this.source = this.stages.get(stage);
    this.stages.delete(stage);
    if (this.fail("stage-to-source")) return this.failed(result);

    if (this.prior) {
      this.retired = this.prior;
      this.prior = undefined;
    }
    if (this.fail("prior-to-retired")) return this.failed(result);

    this.retired = undefined;
    if (this.fail("retired-delete")) return this.failed(result);
    return result;
  }

  private fail(boundary: SwapFailureBoundary): boolean {
    if (this.injected || this.failAt !== boundary) return false;
    this.injected = true;
    return true;
  }

  private failed(
    result: Awaited<ReturnType<FakeArchiveSession["exec"]>>,
  ): Awaited<ReturnType<FakeArchiveSession["exec"]>> {
    return {
      ...result,
      success: false,
      exitCode: 1,
      stderr: `simulated crash after ${this.failAt}`,
    };
  }
}

type FakeStoredObject = {
  key: string;
  size: number;
  etag: string;
  bytes: Uint8Array;
  checksums: { sha256: ArrayBuffer; toJSON(): { sha256: string } };
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
};

class FakeArchiveBucket {
  readonly objects = new Map<string, FakeStoredObject>();
  readonly putOptions: unknown[] = [];
  readonly getOptions: unknown[] = [];
  readonly failBeforeStoreKeys = new Set<string>();
  putCalls = 0;
  failAfterStoreOnce = false;
  getBytesOverride?: Uint8Array;
  corruptGetMetadata = false;
  stallGetBody = false;
  bodyCancelNeverSettles = false;
  bodyCancelCalls = 0;

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? (this.publicObject(stored) as R2Object) : null;
  }

  async put(
    key: string,
    value: ReadableStream,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putCalls += 1;
    this.putOptions.push(options);
    if (this.objects.has(key) && options?.onlyIf) return null;
    if (this.failBeforeStoreKeys.delete(key)) {
      throw new Error("simulated put failure before storage");
    }
    const bytes = await collect(value as ReadableStream<Uint8Array>);
    const digest = await sha256BytesHex(bytes);
    const supplied = options?.sha256;
    if (!(supplied instanceof ArrayBuffer) || hex(supplied) !== digest) {
      throw new Error("fake R2 checksum mismatch");
    }
    const stored: FakeStoredObject = {
      key,
      size: bytes.byteLength,
      etag: `etag-${digest.slice(0, 24)}`,
      bytes,
      checksums: {
        sha256: supplied.slice(0),
        toJSON: () => ({ sha256: digest }),
      },
      httpMetadata: {
        contentType:
          options?.httpMetadata instanceof Headers
            ? (options.httpMetadata.get("content-type") ?? undefined)
            : options?.httpMetadata?.contentType,
      },
      customMetadata: { ...(options?.customMetadata ?? {}) },
    };
    this.objects.set(key, stored);
    if (this.failAfterStoreOnce) {
      this.failAfterStoreOnce = false;
      throw new Error("simulated lost put response");
    }
    return this.publicObject(stored) as R2Object;
  }

  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    this.getOptions.push(options);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const conditional = options?.onlyIf;
    if (
      conditional &&
      !(conditional instanceof Headers) &&
      conditional.etagMatches !== undefined &&
      conditional.etagMatches !== stored.etag
    ) {
      return this.publicObject(stored) as R2Object;
    }
    const publicObject = this.publicObject(stored);
    if (this.corruptGetMetadata) {
      publicObject.customMetadata = {
        ...publicObject.customMetadata,
        stellaKind:
          stored.customMetadata.stellaKind === "native"
            ? "workspace"
            : "native",
      };
    }
    return {
      ...publicObject,
      body:
        this.corruptGetMetadata || this.stallGetBody
          ? new ReadableStream<Uint8Array>({
              cancel: () => {
                this.bodyCancelCalls += 1;
                if (this.bodyCancelNeverSettles) {
                  return new Promise<void>(() => undefined);
                }
              },
            })
          : byteStream(this.getBytesOverride ?? stored.bytes),
      bodyUsed: false,
      arrayBuffer: async () => (this.getBytesOverride ?? stored.bytes).buffer,
      bytes: async () => (this.getBytesOverride ?? stored.bytes).slice(),
      text: async () =>
        new TextDecoder().decode(this.getBytesOverride ?? stored.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
      blob: async () => new Blob([stored.bytes]),
    } as unknown as R2ObjectBody;
  }

  corruptMetadata(key: string): void {
    const stored = this.objects.get(key);
    if (!stored) throw new Error("missing fake object");
    stored.customMetadata = { ...stored.customMetadata, stellaKind: "native" };
  }

  private publicObject(stored: FakeStoredObject): Partial<R2Object> {
    return {
      key: stored.key,
      version: "v1",
      size: stored.size,
      etag: stored.etag,
      httpEtag: `\"${stored.etag}\"`,
      checksums: stored.checksums as R2Checksums,
      uploaded: new Date(0),
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
    };
  }

  asUploadBucket(): Pick<R2Bucket, "head" | "put"> {
    return this as unknown as Pick<R2Bucket, "head" | "put">;
  }

  asRestoreBucket(): Pick<R2Bucket, "head" | "get"> {
    return this as unknown as Pick<R2Bucket, "head" | "get">;
  }
}

describe("turn state archive", () => {
  test("shares one exact workspace/native R2 metadata contract", () => {
    const workspace = {
      kind: "workspace" as const,
      key: archiveKey("workspace"),
      sizeBytes: 17,
      sha256: "a".repeat(64),
    };
    const native = {
      kind: "native" as const,
      key: archiveKey("native"),
      sizeBytes: 23,
      sha256: "b".repeat(64),
    };

    const workspaceMetadata = turnStateArchiveMetadata(workspace, {
      kind: "workspace",
      workspaceRoot: "/workspace/project",
    });
    expect(workspaceMetadata).toEqual({
      stellaSchemaVersion: "1",
      stellaKind: "workspace",
      stellaFormat: "squashfs-zstd-v1",
      stellaKey: workspace.key,
      stellaDirectory: "/workspace/project",
      stellaSizeBytes: "17",
      stellaSha256: "a".repeat(64),
      stellaComplete: "true",
    });
    expect(
      turnStateArchiveMetadataMatches(workspaceMetadata, workspace, {
        kind: "workspace",
        workspaceRoot: "/workspace/project",
      }),
    ).toBe(true);
    expect(
      turnStateArchiveMetadataMatches(
        { ...workspaceMetadata, unregistered: "value" },
        workspace,
        { kind: "workspace", workspaceRoot: "/workspace/project" },
      ),
    ).toBe(false);
    expect(
      turnStateArchiveMetadata(native, { kind: "native" }).stellaDirectory,
    ).toBe("/home/stella-native-state/anthropic");
    expect(() =>
      turnStateArchiveMetadata(workspace, { kind: "native" }),
    ).toThrow("metadata target kind does not match");
  });

  test("uploads a bounded workspace SquashFS to its exact reserved key", async () => {
    const bytes = encoder.encode("deterministic workspace squashfs");
    const session = new FakeArchiveSession(bytes);
    const bucket = new FakeArchiveBucket();
    const key = archiveKey("workspace");

    const result = await uploadTurnStateArchive({
      session: session.asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "workspace", workspaceRoot: "/workspace/project" },
    });

    expect(result.replayed).toBe(false);
    expect(result.archive).toEqual({
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      kind: "workspace",
      format: TURN_STATE_OBJECT_FORMAT,
      key,
      sizeBytes: bytes.byteLength,
      sha256: await sha256BytesHex(bytes),
      etag: `etag-${(await sha256BytesHex(bytes)).slice(0, 24)}`,
      complete: true,
    });
    expect(bucket.putCalls).toBe(1);
    const options = bucket.putOptions[0] as R2PutOptions;
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(options.httpMetadata).toEqual({
      contentType: "application/vnd.squashfs",
    });
    expect(options.customMetadata).toEqual({
      stellaSchemaVersion: "1",
      stellaKind: "workspace",
      stellaFormat: "squashfs-zstd-v1",
      stellaKey: key,
      stellaDirectory: "/workspace/project",
      stellaSizeBytes: String(bytes.byteLength),
      stellaSha256: await sha256BytesHex(bytes),
      stellaComplete: "true",
    });
    expect(hex(options.sha256 as ArrayBuffer)).toBe(
      await sha256BytesHex(bytes),
    );
    expect(
      session.commands.some((command) =>
        command.includes("mksquashfs /workspace/project"),
      ),
    ).toBe(true);
    expect(
      session.commands.some((command) =>
        command.includes("-no-xattrs -reproducible -mkfs-time 0"),
      ),
    ).toBe(true);
    expect(session.commands.every((command) => !command.includes(key))).toBe(
      true,
    );
    expect(session.commands.at(-1)).toContain(
      "/home/stella-host-state/turn-state-archive/workspace-project-",
    );
  });

  test("recovers a lost put response and exact later retries without overwriting", async () => {
    const bytes = encoder.encode("replay-stable squashfs bytes");
    const bucket = new FakeArchiveBucket();
    bucket.failAfterStoreOnce = true;
    const key = archiveKey("workspace");

    const first = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
    });
    expect(first.replayed).toBe(true);
    expect(bucket.putCalls).toBe(1);

    const second = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
    });
    expect(second).toEqual(first);
    expect(bucket.putCalls).toBe(1);
  });

  test("cancels a malformed Sandbox read before failing closed", async () => {
    const bytes = encoder.encode("malformed Sandbox stream");
    const session = new FakeArchiveSession(bytes);
    session.reportedReadSize = bytes.byteLength + 1;
    const bucket = new FakeArchiveBucket();

    await expect(
      uploadTurnStateArchive({
        session: session.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("workspace"),
        target: { kind: "workspace", workspaceRoot: "/workspace/project" },
      }),
    ).rejects.toThrow("sandbox stream is invalid");
    expect(session.readCancelCalls).toBe(1);
    expect(bucket.putCalls).toBe(0);
  });

  test("reclaims an expired crash claim and replays a durable upload after cleanup loss", async () => {
    const bytes = encoder.encode("crash-recoverable squashfs bytes");
    const bucket = new FakeArchiveBucket();
    const claims = new FakeClaimManager();
    const firstSession = new FakeArchiveSession(bytes, claims);
    firstSession.failCleanupOnce = true;
    const key = archiveKey("workspace", "1");

    await expect(
      uploadTurnStateArchive({
        session: firstSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key,
        target: { kind: "workspace", workspaceRoot: "/workspace/project" },
      }),
    ).rejects.toThrow("scratch cleanup failed");
    expect(bucket.objects.has(key)).toBe(true);
    expect(claims.claims.size).toBe(1);
    expect(
      firstSession.commands.some(
        (command) =>
          command.includes("-mmin +20") &&
          command.includes("workspace-project-*.sqsh"),
      ),
    ).toBe(true);

    claims.expireAll();
    const retrySession = new FakeArchiveSession(bytes, claims);
    const retry = await uploadTurnStateArchive({
      session: retrySession.asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "workspace", workspaceRoot: "/workspace/project" },
    });
    expect(retry.replayed).toBe(true);
    expect(bucket.putCalls).toBe(1);
    expect(claims.claims.size).toBe(0);
    expect(retrySession.commands.at(-1)).toContain(
      "/usr/bin/flock --exclusive --wait 30 9",
    );
  });

  test("re-addresses a workspace/native pair and resumes after a partial copy", async () => {
    const workspaceBytes = encoder.encode("source workspace squashfs");
    const nativeBytes = encoder.encode("source native squashfs");
    const bucket = new FakeArchiveBucket();
    const sourceWorkspace = await uploadTurnStateArchive({
      session: new FakeArchiveSession(workspaceBytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("workspace", "a"),
      target: { kind: "workspace", workspaceRoot: "/workspace/project" },
    });
    const sourceNative = await uploadTurnStateArchive({
      session: new FakeArchiveSession(nativeBytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("native", "a"),
      target: { kind: "native" },
    });
    const destinationWorkspaceKey = archiveKey("workspace", "c", "9", "8");
    const destinationNativeKey = archiveKey("native", "c", "9", "8");
    const mismatchedNativeKey = archiveKey("native", "d", "9", "8");
    await expect(
      copyTurnStateArchivePair({
        bucket: bucket as unknown as Pick<R2Bucket, "get" | "head" | "put">,
        workspace: {
          source: sourceWorkspace.archive,
          destinationKey: destinationWorkspaceKey,
          target: {
            kind: "workspace",
            workspaceRoot: "/workspace/project",
          },
        },
        native: {
          source: sourceNative.archive,
          destinationKey: mismatchedNativeKey,
          target: { kind: "native" },
        },
      }),
    ).rejects.toThrow("copy pair addresses do not match");
    expect(bucket.putCalls).toBe(2);
    expect(bucket.objects.has(destinationWorkspaceKey)).toBe(false);
    expect(bucket.objects.has(mismatchedNativeKey)).toBe(false);

    bucket.failBeforeStoreKeys.add(destinationNativeKey);
    const pair = {
      bucket: bucket as unknown as Pick<R2Bucket, "get" | "head" | "put">,
      workspace: {
        source: sourceWorkspace.archive,
        destinationKey: destinationWorkspaceKey,
        target: {
          kind: "workspace" as const,
          workspaceRoot: "/workspace/project" as const,
        },
      },
      native: {
        source: sourceNative.archive,
        destinationKey: destinationNativeKey,
        target: { kind: "native" as const },
      },
    };

    await expect(copyTurnStateArchivePair(pair)).rejects.toThrow(
      "simulated put failure before storage",
    );
    expect(bucket.objects.has(destinationWorkspaceKey)).toBe(true);
    expect(bucket.objects.has(destinationNativeKey)).toBe(false);
    expect(bucket.objects.has(sourceWorkspace.archive.key)).toBe(true);
    expect(bucket.objects.has(sourceNative.archive.key)).toBe(true);

    const resumed = await copyTurnStateArchivePair(pair);
    expect(resumed.workspace.replayed).toBe(true);
    expect(resumed.native?.replayed).toBe(false);
    expect(resumed.workspace.archive.key).toBe(destinationWorkspaceKey);
    expect(resumed.native?.archive.key).toBe(destinationNativeKey);
    expect(bucket.objects.get(destinationWorkspaceKey)?.customMetadata).toEqual(
      {
        stellaSchemaVersion: "1",
        stellaKind: "workspace",
        stellaFormat: "squashfs-zstd-v1",
        stellaKey: destinationWorkspaceKey,
        stellaDirectory: "/workspace/project",
        stellaSizeBytes: String(workspaceBytes.byteLength),
        stellaSha256: await sha256BytesHex(workspaceBytes),
        stellaComplete: "true",
      },
    );
    expect(
      hex(
        bucket.objects.get(destinationNativeKey)!.checksums
          .sha256 as ArrayBuffer,
      ),
    ).toBe(await sha256BytesHex(nativeBytes));
  });

  test("recovers an exact re-addressed object after a lost copy response", async () => {
    const bytes = encoder.encode("lost-response source squashfs");
    const bucket = new FakeArchiveBucket();
    const source = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("workspace", "4"),
      target: { kind: "workspace", workspaceRoot: "/workspace/stella" },
    });
    bucket.failAfterStoreOnce = true;
    const destinationKey = archiveKey("workspace", "5", "6", "7");
    const copied = await copyTurnStateArchivePair({
      bucket: bucket as unknown as Pick<R2Bucket, "get" | "head" | "put">,
      workspace: {
        source: source.archive,
        destinationKey,
        target: { kind: "workspace", workspaceRoot: "/workspace/stella" },
      },
    });

    expect(copied.workspace.replayed).toBe(true);
    expect(copied.workspace.archive.key).toBe(destinationKey);
    expect(bucket.objects.has(source.archive.key)).toBe(true);
  });

  test("re-addresses a native archive independently of workspace head", async () => {
    const bytes = encoder.encode("per-thread native squashfs");
    const bucket = new FakeArchiveBucket();
    const source = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("native", "4"),
      target: { kind: "native" },
    });
    const destinationKey = archiveKey("native", "5", "6", "7");
    const copied = await copyTurnStateArchive({
      bucket: bucket as unknown as Pick<R2Bucket, "get" | "head" | "put">,
      source: source.archive,
      destinationKey,
      target: { kind: "native" },
    });

    expect(copied.replayed).toBe(false);
    expect(copied.archive.key).toBe(destinationKey);
    expect(bucket.objects.has(source.archive.key)).toBe(true);
    expect(bucket.objects.get(destinationKey)?.customMetadata).toEqual(
      turnStateArchiveMetadata(copied.archive, { kind: "native" }),
    );
  });

  test("fails closed when a reserved key already contains conflicting metadata", async () => {
    const bytes = encoder.encode("workspace squashfs");
    const bucket = new FakeArchiveBucket();
    const key = archiveKey("workspace");
    await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "workspace", workspaceRoot: "/workspace/stella" },
    });
    bucket.corruptMetadata(key);

    await expect(
      uploadTurnStateArchive({
        session: new FakeArchiveSession(bytes).asSession(),
        bucket: bucket.asUploadBucket(),
        key,
        target: { kind: "workspace", workspaceRoot: "/workspace/stella" },
      }),
    ).rejects.toThrow("conflicts with its reservation");
    expect(bucket.putCalls).toBe(1);
  });

  test("restores native state only after head, conditional get, and byte verification", async () => {
    const bytes = encoder.encode("native checkpoint squashfs");
    const bucket = new FakeArchiveBucket();
    const key = archiveKey("native");
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "native" },
    });
    const restoreSession = new FakeArchiveSession(bytes);

    await restoreTurnStateArchive({
      session: restoreSession.asSession(),
      bucket: bucket.asRestoreBucket(),
      archive: uploaded.archive,
      target: { kind: "native" },
    });

    expect(bucket.getOptions).toEqual([
      { onlyIf: { etagMatches: uploaded.archive.etag } },
    ]);
    expect(restoreSession.restoreCalls).toBe(1);
    expect(
      restoreSession.commands.some(
        (command) =>
          command.includes("unsquashfs -no-progress -no-xattrs") &&
          command.includes("/home/stella-native-state/anthropic"),
      ),
    ).toBe(true);
    expect(restoreSession.commands.at(-1)).toContain(
      "rm -f -- /home/stella-host-state/turn-state-archive/native-",
    );
  });

  test("does not extract a body whose bytes disagree with the registered digest", async () => {
    const bytes = encoder.encode("registered native squashfs");
    const bucket = new FakeArchiveBucket();
    const key = archiveKey("native");
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "native" },
    });
    bucket.getBytesOverride = bytes.slice();
    bucket.getBytesOverride[0] ^= 0xff;
    const restoreSession = new FakeArchiveSession(bytes);

    await expect(
      restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "native" },
      }),
    ).rejects.toThrow("downloaded bytes failed integrity");
    expect(restoreSession.restoreCalls).toBe(0);
    expect(restoreSession.commands.at(-1)).toContain("rm -f --");
  });

  test("cancels an R2 body whose GET metadata conflicts with HEAD", async () => {
    const bytes = encoder.encode("conflicting GET metadata squashfs");
    const bucket = new FakeArchiveBucket();
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("native"),
      target: { kind: "native" },
    });
    bucket.corruptGetMetadata = true;
    bucket.bodyCancelNeverSettles = true;
    const restoreSession = new FakeArchiveSession(bytes);

    await expect(
      restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "native" },
      }),
    ).rejects.toThrow("conflicts with its reservation");
    expect(bucket.bodyCancelCalls).toBe(1);
    expect(restoreSession.writes.size).toBe(0);
    expect(restoreSession.restoreCalls).toBe(0);
  });

  test("cancels a validated R2 body when the restore claim heartbeat fails", async () => {
    const bytes = encoder.encode("heartbeat failure native squashfs");
    const bucket = new FakeArchiveBucket();
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("native"),
      target: { kind: "native" },
    });
    bucket.stallGetBody = true;
    const restoreSession = new FakeArchiveSession(bytes);
    restoreSession.failHeartbeatOnce = true;

    await expect(
      restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "native" },
      }),
    ).rejects.toThrow("claim heartbeat failed");
    expect(bucket.bodyCancelCalls).toBe(1);
    expect(restoreSession.writes.size).toBe(0);
    expect(restoreSession.restoreCalls).toBe(0);
  });

  test("cancels a restore stream when the sandbox rejects its write", async () => {
    const bytes = encoder.encode("native write rejection squashfs");
    const bucket = new FakeArchiveBucket();
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("native"),
      target: { kind: "native" },
    });
    const restoreSession = new FakeArchiveSession(bytes);
    restoreSession.failWriteBeforeRead = true;

    await expect(
      restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "native" },
      }),
    ).rejects.toThrow("sandbox write was incomplete");
    expect(restoreSession.restoreCalls).toBe(0);
    expect(restoreSession.commands.at(-1)).toContain("rm -f --");
  });

  test("binds a workspace archive to the exact fixed workspace root", async () => {
    const bytes = encoder.encode("project-only squashfs");
    const bucket = new FakeArchiveBucket();
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("workspace"),
      target: { kind: "workspace", workspaceRoot: "/workspace/project" },
    });
    const restoreSession = new FakeArchiveSession(bytes);

    await expect(
      restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "workspace", workspaceRoot: "/workspace/app" },
      }),
    ).rejects.toThrow("conflicts with its reservation");
    expect(bucket.getOptions).toEqual([]);
    expect(restoreSession.writes.size).toBe(0);
    expect(restoreSession.restoreCalls).toBe(0);
  });

  test("uses a bounded claim and disjoint scratch for concurrent retries", async () => {
    const bytes = encoder.encode("concurrency-safe squashfs");
    const claims = new FakeClaimManager();
    const firstSession = new FakeArchiveSession(bytes, claims);
    const secondSession = new FakeArchiveSession(bytes, claims);
    const bucket = new FakeArchiveBucket();
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    let releaseRead!: () => void;
    const holdRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    firstSession.beforeRead = async () => {
      signalRead();
      await holdRead;
    };
    const first = uploadTurnStateArchive({
      session: firstSession.asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("workspace", "e"),
      target: { kind: "workspace", workspaceRoot: "/workspace/project" },
    });
    await readStarted;

    await expect(
      uploadTurnStateArchive({
        session: secondSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("workspace", "e"),
        target: { kind: "workspace", workspaceRoot: "/workspace/project" },
      }),
    ).rejects.toThrow("archive creation failed");

    releaseRead();
    const firstResult = await first;
    expect(firstResult.replayed).toBe(false);
    expect(claims.claims.size).toBe(0);
    const firstBuild = firstSession.commands.find((command) =>
      command.includes("mksquashfs "),
    );
    const secondBuild = secondSession.commands.find((command) =>
      command.includes("mksquashfs "),
    );
    expect(firstBuild).toContain("exec 9<>");
    expect(firstBuild).toContain("/usr/bin/flock --exclusive --nonblock 9");
    expect(firstBuild).toContain(
      "/home/stella-host-state/turn-state-archive/lock-workspace-project",
    );
    expect(firstBuild).toContain("set -C; : >");
    expect(firstBuild).not.toContain(
      "/dev/null /home/stella-host-state/turn-state-archive/lock-workspace-project",
    );
    const scratchPath = (command: string | undefined): string | undefined =>
      /\/home\/stella-host-state\/turn-state-archive\/workspace-project-([0-9a-f]{64})\.sqsh/u.exec(
        command ?? "",
      )?.[0];
    expect(scratchPath(firstBuild)).toBeDefined();
    expect(scratchPath(secondBuild)).toBeDefined();
    expect(scratchPath(firstBuild)).not.toBe(scratchPath(secondBuild));
  });

  test("keeps an old tree recoverable across every target-swap failure", async () => {
    const bytes = encoder.encode("rollback-aware squashfs");
    const bucket = new FakeArchiveBucket();
    const uploaded = await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key: archiveKey("workspace"),
      target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
    });
    const boundaries: SwapFailureBoundary[] = [
      "source-to-prior",
      "stage-to-source",
      "prior-to-retired",
      "retired-delete",
    ];
    for (const boundary of boundaries) {
      const restoreSession = new SwapStateArchiveSession(bytes, boundary);
      await expect(
        restoreTurnStateArchive({
          session: restoreSession.asSession(),
          bucket: bucket.asRestoreBucket(),
          archive: uploaded.archive,
          target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
        }),
      ).rejects.toThrow("target swap failed");
      expect(
        [
          restoreSession.source,
          restoreSession.prior,
          restoreSession.retired,
        ].filter(Boolean).length,
      ).toBeGreaterThan(0);

      await restoreTurnStateArchive({
        session: restoreSession.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive: uploaded.archive,
        target: { kind: "workspace", workspaceRoot: "/workspace/drive" },
      });
      expect(restoreSession.source).toBe("new");
      expect(restoreSession.prior).toBeUndefined();
      expect(restoreSession.retired).toBeUndefined();
      expect(restoreSession.stages.size).toBe(0);
    }
  });

  test("rejects malformed keys, arbitrary roots, and objects above R2's single-part boundary", async () => {
    const bytes = encoder.encode("bounded archive");
    const bucket = new FakeArchiveBucket();
    expect(TURN_STATE_MAX_ARCHIVE_BYTES).toBe(
      5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024,
    );
    const malformedSession = new FakeArchiveSession(bytes);
    await expect(
      uploadTurnStateArchive({
        session: malformedSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: `${TURN_STATE_OBJECT_PREFIX}/workspace.sqsh`,
        target: { kind: "workspace", workspaceRoot: "/workspace/project" },
      }),
    ).rejects.toThrow("was not pre-registered");
    expect(malformedSession.commands).toEqual([]);

    for (const suffix of ["\n", "\r", "\r\n"]) {
      const controlSession = new FakeArchiveSession(bytes);
      await expect(
        uploadTurnStateArchive({
          session: controlSession.asSession(),
          bucket: bucket.asUploadBucket(),
          key: `${archiveKey("workspace")}${suffix}`,
          target: { kind: "workspace", workspaceRoot: "/workspace/project" },
        }),
      ).rejects.toThrow("was not pre-registered");
      expect(controlSession.commands).toEqual([]);
    }

    const rootSession = new FakeArchiveSession(bytes);
    await expect(
      uploadTurnStateArchive({
        session: rootSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("workspace"),
        target: {
          kind: "workspace",
          workspaceRoot: "/workspace/project; touch /tmp/escaped",
        } as never,
      }),
    ).rejects.toThrow("workspace root is invalid");
    expect(
      rootSession.commands.every((command) => !command.includes("escaped")),
    ).toBe(true);

    const oversizedSession = new FakeArchiveSession(bytes);
    oversizedSession.reportedSize = TURN_STATE_MAX_ARCHIVE_BYTES + 1;
    await expect(
      uploadTurnStateArchive({
        session: oversizedSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("workspace"),
        target: { kind: "workspace", workspaceRoot: "/workspace/app" },
      }),
    ).rejects.toThrow("exceeds its bounded object contract");
    expect(bucket.putCalls).toBe(0);
    expect(oversizedSession.commands.at(-1)).toContain("rm -f --");
  });

  test("rejects restore kind mismatches before touching sandbox or R2", async () => {
    const session = new FakeArchiveSession(encoder.encode("unused"));
    const bucket = new FakeArchiveBucket();
    const archive: TurnStateArchive = {
      schemaVersion: 1,
      kind: "workspace",
      format: "squashfs-zstd-v1",
      key: archiveKey("workspace"),
      sizeBytes: 1,
      sha256: "a".repeat(64),
      etag: "etag",
      complete: true,
    };
    await expect(
      restoreTurnStateArchive({
        session: session.asSession(),
        bucket: bucket.asRestoreBucket(),
        archive,
        target: { kind: "native" },
      }),
    ).rejects.toThrow("target kind does not match");
    expect(session.commands).toEqual([]);
  });
});
