import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { DirectoryBackup } from "@cloudflare/sandbox";
import {
  NATIVE_STATE_CHECKPOINT_SCHEMA_VERSION,
  emptyNativeStateCheckpointRecord,
  nativeHistoryCursorFromRows,
  nativeStateBackupName,
  nativeStateCheckpointKey,
  nativeStateCheckpointPrefix,
  nativeStateCheckpointReceipt,
  parseNativeStateCheckpointPayload,
  parseNativeStateCheckpointRecord,
  publicNativeStateCheckpointReceipt,
  resolveNativeStateCheckpoint,
  stageNativeStateCheckpoint,
  validNativeStateCheckpointMac,
  type NativeStateCheckpoint,
  type NativeStateCheckpointVersion,
} from "../src/native-state-checkpoint.js";

const integrityKey = "a".repeat(64);
const threadId = "thread-1";

const checkpoint = (
  cursor: string,
  treeDigest = "b".repeat(64),
): NativeStateCheckpoint => {
  const unsigned = [
    2,
    "anthropic",
    threadId,
    "session-1",
    cursor,
    "sha256",
    treeDigest,
    4,
    123,
  ];
  return {
    engine: "anthropic",
    sessionId: "session-1",
    cursor,
    tree: {
      algorithm: "sha256",
      digest: treeDigest,
      entries: 4,
      bytes: 123,
    },
    mac: createHmac("sha256", integrityKey)
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  };
};

const descriptor = (id: string): DirectoryBackup =>
  ({
    id,
    dir: "/home/stella-native-state/anthropic",
    localBucket: true,
  }) as DirectoryBackup;

const version = (
  id: string,
  cursor: string,
  requestFingerprint = `request-${id}`,
): NativeStateCheckpointVersion => ({
  checkpoint: checkpoint(cursor),
  descriptor: descriptor(id),
  requestFingerprint,
  receipt: createHash("sha256").update(`receipt-${id}`).digest("hex"),
  createdAt: 1_800_000_000_000,
});

describe("native state checkpoint protocol", () => {
  test("accepts only the exact bounded checkpoint shape and rechecks its HMAC", async () => {
    const payload = {
      schemaVersion: NATIVE_STATE_CHECKPOINT_SCHEMA_VERSION,
      checkpoint: checkpoint("v1:cursor-1"),
    };
    expect(parseNativeStateCheckpointPayload(payload)).toEqual(payload);
    expect(
      await validNativeStateCheckpointMac({
        checkpoint: payload.checkpoint,
        threadId,
        integrityKey,
      }),
    ).toBe(true);
    expect(
      await validNativeStateCheckpointMac({
        checkpoint: {
          ...payload.checkpoint,
          tree: { ...payload.checkpoint.tree, bytes: 124 },
        },
        threadId,
        integrityKey,
      }),
    ).toBe(false);
    expect(
      parseNativeStateCheckpointPayload({ ...payload, hidden: "field" }),
    ).toBeNull();
    expect(
      parseNativeStateCheckpointPayload({
        ...payload,
        checkpoint: { ...payload.checkpoint, cursor: " bad " },
      }),
    ).toBeNull();
  });

  test("derives the same canonical cursor and owner-private storage namespace", async () => {
    const row = {
      turnId: "turn-1",
      role: "assistant",
      payloadJson: '{"role":"assistant","content":"done"}',
    };
    const expected = createHash("sha256")
      .update(JSON.stringify(row))
      .digest("hex");
    expect(await nativeHistoryCursorFromRows([])).toBe("v1:empty");
    expect(await nativeHistoryCursorFromRows([row])).toBe(`v1:${expected}`);
    const key = await nativeStateCheckpointKey("workspace-abc", threadId);
    expect(key).toStartWith(nativeStateCheckpointPrefix("workspace-abc"));
    expect(key).not.toContain(threadId);
    expect(await nativeStateBackupName(key)).toMatch(
      /^native-state-[0-9a-f]{40}$/,
    );
  });

  test("stages once and returns the identical durable version on exact replay", async () => {
    const state = checkpoint("v1:new");
    const backup = descriptor("backup-new");
    const requestFingerprint = "c".repeat(64);
    const receipt = await nativeStateCheckpointReceipt({
      descriptor: backup,
      checkpoint: state,
      requestFingerprint,
    });
    const staged = stageNativeStateCheckpoint({
      record: emptyNativeStateCheckpointRecord(),
      checkpoint: state,
      descriptor: backup,
      requestFingerprint,
      receipt,
      createdAt: 1,
    });
    expect(staged.kind).toBe("staged");
    if (staged.kind !== "staged") throw new Error(staged.kind);

    const replay = stageNativeStateCheckpoint({
      record: staged.record,
      checkpoint: state,
      descriptor: descriptor("must-not-replace-the-first-backup"),
      requestFingerprint,
      receipt: "d".repeat(64),
      createdAt: 2,
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error(replay.kind);
    expect(replay.version.descriptor.id).toBe("backup-new");
    expect(publicNativeStateCheckpointReceipt(replay.version, true)).toEqual({
      schemaVersion: 1,
      cursor: "v1:new",
      treeDigest: "b".repeat(64),
      receipt,
      replayed: true,
    });
    expect(
      stageNativeStateCheckpoint({
        record: staged.record,
        checkpoint: checkpoint("v1:new", "e".repeat(64)),
        descriptor: backup,
        requestFingerprint,
        receipt,
        createdAt: 2,
      }).kind,
    ).toBe("conflict");
  });

  test("accepts only bounded root-private backup records from KV", () => {
    const durable = version(
      "00000000-0000-4000-8000-000000000001",
      "v1:durable",
      "d".repeat(64),
    );
    const record = {
      schemaVersion: 1 as const,
      committed: durable,
      candidates: [],
    };
    expect(parseNativeStateCheckpointRecord(record)).toEqual(record);
    expect(
      parseNativeStateCheckpointRecord({
        ...record,
        committed: {
          ...durable,
          descriptor: { ...durable.descriptor, dir: "/workspace/drive" },
        },
      }),
    ).toBeNull();
    expect(
      parseNativeStateCheckpointRecord({
        ...record,
        committed: {
          ...durable,
          descriptor: { ...durable.descriptor, localBucket: false },
        },
      }),
    ).toBeNull();
    expect(
      parseNativeStateCheckpointRecord({
        ...record,
        candidates: [durable],
      }),
    ).toBeNull();
  });

  test("keeps old bytes authoritative when transcript append fails", () => {
    const old = version("backup-old", "v1:old");
    const candidate = version("backup-new", "v1:new");
    const resolved = resolveNativeStateCheckpoint(
      { schemaVersion: 1, committed: old, candidates: [candidate] },
      "v1:old",
    );
    expect(resolved.restore).toEqual(old);
    expect(resolved.promoted).toBe(false);
    expect(resolved.record).toEqual({
      schemaVersion: 1,
      committed: old,
      candidates: [],
    });
    expect(resolved.retiredBackupIds).toEqual(["backup-new"]);
  });

  test("promotes candidate bytes only after their transcript cursor is canonical", () => {
    const old = version("backup-old", "v1:old");
    const candidate = version("backup-new", "v1:new");
    const abandoned = version("backup-abandoned", "v1:abandoned");
    const resolved = resolveNativeStateCheckpoint(
      {
        schemaVersion: 1,
        committed: old,
        candidates: [candidate, abandoned],
      },
      "v1:new",
    );
    expect(resolved.restore).toEqual(candidate);
    expect(resolved.promoted).toBe(true);
    expect(resolved.record.committed).toEqual(candidate);
    expect(resolved.record.candidates).toEqual([]);
    expect(resolved.retiredBackupIds).toEqual([
      "backup-old",
      "backup-abandoned",
    ]);
  });

  test("fails selection closed when no checkpoint matches canonical history", () => {
    const old = version("backup-old", "v1:old");
    const candidate = version("backup-new", "v1:new");
    const resolved = resolveNativeStateCheckpoint(
      { schemaVersion: 1, committed: old, candidates: [candidate] },
      "v1:unknown",
    );
    expect(resolved.restore).toBeUndefined();
    expect(resolved.record).toEqual({ schemaVersion: 1, candidates: [] });
    expect(resolved.retiredBackupIds).toEqual(["backup-old", "backup-new"]);
  });
});
