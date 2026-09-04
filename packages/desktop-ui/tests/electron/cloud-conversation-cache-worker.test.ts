import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CloudConversationCacheClient } from "../../../desktop/electron/services/cloud-conversation-cache-client.js";

const root = mkdtempSync(path.join(tmpdir(), "stella-cache-worker-"));
const workerPath = path.join(root, "cloud-conversation-cache-worker.js");
const servicePath = path.join(root, "service.mjs");
const databasePath = path.join(root, "cache.sqlite");
const authority = {
  accountScope: "account:a",
  ownerGeneration: "generation:a",
  conversationId: "conversation:a",
};
const lifecycle = {
  accountScope: authority.accountScope,
  ownerGeneration: authority.ownerGeneration,
};
const record = {
  kind: "message",
  seq: 0,
  turnId: "turn:0",
  createdAtMs: 1,
  role: "user",
  hidden: false,
  payload: { content: "hello" },
};
const replacement = {
  ...authority,
  expected: null,
  epoch: 1,
  headSeq: 0,
  floorSeq: 0,
  title: "Cache",
  records: [record],
};
let client: CloudConversationCacheClient;

beforeAll(async () => {
  await build({
    entryPoints: {
      "cloud-conversation-cache-worker": path.resolve(
        import.meta.dirname,
        "../../../desktop/electron/services/cloud-conversation-cache-worker.ts",
      ),
      service: path.resolve(
        import.meta.dirname,
        "../../../desktop/electron/services/local-chat-history-service.ts",
      ),
    },
    outdir: root,
    outExtension: { ".js": ".mjs" },
    external: ["bun:*"],
    bundle: true,
    platform: "node",
    format: "esm",
  });
  renameSync(
    path.join(root, "cloud-conversation-cache-worker.mjs"),
    workerPath,
  );
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.close();
  client = new CloudConversationCacheClient(
    databasePath,
    pathToFileURL(workerPath),
  );
});
afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

test("worker validates untrusted rows and serializes authority changes with writes", async () => {
  const activated = client.request("activate", lifecycle);
  expect(client.getActiveAuthority()).toBeNull();
  const write = client.request("replace", replacement);
  await activated;
  expect(await write).toMatchObject({ status: "applied" });
  expect(client.getActiveAuthority()).toEqual(lifecycle);
  expect(await client.request("read", authority)).toMatchObject({
    records: [record],
    revision: 1,
  });
  await expect(
    client.request("replace", {
      ...replacement,
      records: [{ ...record, payload: { password: "forbidden" } }],
    }),
  ).rejects.toThrow();
  // Concurrent callers retain FIFO order; an earlier response must never
  // restore an authority that a queued account change has already invalidated.
  const read = client.request("read", authority);
  const retained = client.request("retain", { accountScope: "account:b" });
  expect(client.getActiveAuthority()).toBeNull();
  await read;
  expect(client.getActiveAuthority()).toBeNull();
  await retained;
  expect(await client.request("replace", replacement)).toMatchObject({
    status: "inactive",
  });
  expect(await client.request("read", authority)).toBeNull();
});

test("SQLite lock waits leave the caller event loop responsive", async () => {
  await client.request("activate", lifecycle);
  await client.request("replace", replacement);
  const competingWriter = new DatabaseSync(databasePath);
  competingWriter.exec("BEGIN IMMEDIATE;");
  let settled = false;
  const purge = client.request("purge", authority).finally(() => {
    settled = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
  } finally {
    competingWriter.exec("COMMIT;");
    competingWriter.close();
  }
  expect(await purge).toMatchObject({ purgedConversations: 1 });
});

test("graceful close drains accepted writes before reset can remove the database", async () => {
  await client.request("activate", lifecycle);
  const write = client.request("replace", replacement);
  const closed = client.close();
  await expect(client.request("read", authority)).rejects.toThrow("closing");
  expect(await write).toMatchObject({ status: "applied" });
  await closed;
  const reopened = new CloudConversationCacheClient(
    databasePath,
    pathToFileURL(workerPath),
  );
  try {
    expect(reopened.getActiveAuthority()).toBeNull();
    await reopened.request("activate", lifecycle);
    expect(await reopened.request("read", authority)).toMatchObject({
      records: [record],
    });
  } finally {
    await reopened.close();
  }
});

test("service replaces a failed worker on the next request and reset tolerates worker failure", async () => {
  const { LocalChatHistoryService } = await import(
    pathToFileURL(servicePath).href
  );
  const service = new LocalChatHistoryService({
    stellaAppDir: path.join(root, "service-data"),
  });
  const currentClient = (): { worker: Worker; hasFailed: boolean } =>
    service.cloudConversationCacheStore;
  try {
    await service.activateCloudConversationCacheAuthority(lifecycle);
    await service.replaceCloudConversationCache(replacement);
    const failed = currentClient();
    await failed.worker.terminate();
    expect(failed.hasFailed).toBe(true);
    expect(service.getActiveCloudConversationCacheAuthority()).toBeNull();
    // A fresh worker has no inherited authority; recovery still requires the
    // renderer's explicit activation, and persisted rows survive the restart.
    expect(
      await service.replaceCloudConversationCache(replacement),
    ).toMatchObject({ status: "inactive" });
    expect(currentClient()).not.toBe(failed);
    await service.activateCloudConversationCacheAuthority(lifecycle);
    expect(service.getActiveCloudConversationCacheAuthority()).toEqual(
      lifecycle,
    );
    expect(await service.readCloudConversationCache(authority)).toMatchObject({
      records: [record],
    });
    await currentClient().worker.terminate();
    await expect(service.closeForReset()).resolves.toBeUndefined();
    await service.reopen();
    await service.activateCloudConversationCacheAuthority(lifecycle);
    expect(await service.readCloudConversationCache(authority)).toMatchObject({
      records: [record],
    });
  } finally {
    await service.close();
  }
});
