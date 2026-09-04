import { describe, expect, test } from "bun:test";
import { sha256BytesHex } from "../src/hash.js";
import {
  copyTurnStateArchive,
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
    stored.customMetadata = { ...stored.customMetadata, stellaSha256: "f".repeat(64) };
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
    const key = archiveKey("native");
    await uploadTurnStateArchive({
      session: new FakeArchiveSession(bytes).asSession(),
      bucket: bucket.asUploadBucket(),
      key,
      target: { kind: "native" },
    });
    bucket.corruptMetadata(key);

    await expect(
      uploadTurnStateArchive({
        session: new FakeArchiveSession(bytes).asSession(),
        bucket: bucket.asUploadBucket(),
        key,
        target: { kind: "native" },
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
      key: archiveKey("native", "e"),
      target: { kind: "native" },
    });
    await readStarted;

    await expect(
      uploadTurnStateArchive({
        session: secondSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("native", "e"),
        target: { kind: "native" },
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
      "/home/stella-host-state/turn-state-archive/lock-native",
    );
    expect(firstBuild).toContain("set -C; : >");
    expect(firstBuild).not.toContain(
      "/dev/null /home/stella-host-state/turn-state-archive/lock-native",
    );
    const scratchPath = (command: string | undefined): string | undefined =>
      /\/home\/stella-host-state\/turn-state-archive\/native-([0-9a-f]{64})\.sqsh/u.exec(
        command ?? "",
      )?.[0];
    expect(scratchPath(firstBuild)).toBeDefined();
    expect(scratchPath(secondBuild)).toBeDefined();
    expect(scratchPath(firstBuild)).not.toBe(scratchPath(secondBuild));
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
        target: { kind: "native" },
      }),
    ).rejects.toThrow("was not pre-registered");
    expect(malformedSession.commands).toEqual([]);

    for (const suffix of ["\n", "\r", "\r\n"]) {
      const controlSession = new FakeArchiveSession(bytes);
      await expect(
        uploadTurnStateArchive({
          session: controlSession.asSession(),
          bucket: bucket.asUploadBucket(),
          key: `${archiveKey("native")}${suffix}`,
          target: { kind: "native" },
        }),
      ).rejects.toThrow("was not pre-registered");
      expect(controlSession.commands).toEqual([]);
    }

    const oversizedSession = new FakeArchiveSession(bytes);
    oversizedSession.reportedSize = TURN_STATE_MAX_ARCHIVE_BYTES + 1;
    await expect(
      uploadTurnStateArchive({
        session: oversizedSession.asSession(),
        bucket: bucket.asUploadBucket(),
        key: archiveKey("native"),
        target: { kind: "native" },
      }),
    ).rejects.toThrow("exceeds its bounded object contract");
    expect(bucket.putCalls).toBe(0);
    expect(oversizedSession.commands.at(-1)).toContain("rm -f --");
  });

});

describe("archive scripts never leak shell state into the session", () => {
  test("every archive command runs in a subshell", async () => {
    // The scripts begin with `set -eu`/`umask 077` and hold the lock on fd 9.
    // The session's persistent shell later runs the attached tool-host probe
    // and every bridged call; a leaked errexit ends that shell on the first
    // non-zero command and the daemon with it, which is exactly what every
    // follow-up turn (the only turn that restores a checkpoint) hit.
    const bytes = encoder.encode("subshell-archive-bytes");
    const key = archiveKey("native");
    const bucket = new FakeArchiveBucket();
    const uploadSession = new FakeArchiveSession(bytes);
    const uploaded = await uploadTurnStateArchive({
      session: uploadSession.asSession(),
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

    const commands = [...uploadSession.commands, ...restoreSession.commands];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith("( ")).toBe(true);
      expect(command.endsWith(" )")).toBe(true);
    }
    // The strict options and the lock descriptor are still applied, inside.
    expect(commands.some((command) => command.includes("set -eu"))).toBe(true);
    expect(commands.some((command) => command.includes("exec 9<>"))).toBe(true);
  });
});
