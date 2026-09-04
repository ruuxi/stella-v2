import { Worker } from "node:worker_threads";
import {
  MAX_CLOUD_CONVERSATION_CACHE_RECORDS,
  type CloudConversationCacheLifecycleAuthority,
} from "@stella/contracts/cloud-conversation-cache";

type Operation = "retain" | "activate" | "read" | "replace" | "purge" | "close";

/** Serial worker mailbox preserves lifecycle ordering and SQLite CAS semantics. */
export class CloudConversationCacheClient {
  private readonly worker: Worker;
  private nextId = 0;
  private lifecycleId = 0;
  private authority: CloudConversationCacheLifecycleAuthority | null = null;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    databasePath: string,
    workerUrl = new URL(
      "./cloud-conversation-cache-worker.js",
      import.meta.url,
    ),
  ) {
    this.worker = new Worker(workerUrl, { workerData: { databasePath } });
    this.worker.on("message", ({ id, result, error, authority }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (!error && id >= this.lifecycleId) this.authority = authority;
      if (error) request.reject(new Error(error));
      else request.resolve(result);
      if (this.pending.size === 0) this.worker.unref();
    });
    this.worker.on("error", (error) =>
      this.fail(
        error instanceof Error
          ? error
          : new Error("Cloud cache worker failed."),
      ),
    );
    this.worker.on("exit", () =>
      this.fail(new Error("Cloud cache worker exited.")),
    );
    this.worker.unref();
  }

  private fail(error: Error): void {
    this.failure = error;
    this.authority = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  get hasFailed(): boolean {
    return this.failure !== null;
  }

  getActiveAuthority(): CloudConversationCacheLifecycleAuthority | null {
    return this.authority;
  }

  request<T>(operation: Operation, payload: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing)
      return Promise.reject(new Error("Cloud cache is closing."));
    // Cheap ingress limits only. Recursive validation and serialization belong
    // to the worker, exactly once, immediately before the database operation.
    if (
      operation !== "close" &&
      (!payload || typeof payload !== "object" || Array.isArray(payload))
    ) {
      return Promise.reject(
        new Error("Cloud cache payload must be an object."),
      );
    }
    if (operation === "replace") {
      const records = (payload as { records?: unknown }).records;
      if (
        !Array.isArray(records) ||
        records.length > MAX_CLOUD_CONVERSATION_CACHE_RECORDS
      ) {
        return Promise.reject(
          new Error("Cloud cache record count exceeds its limit."),
        );
      }
    }
    if (this.pending.size >= 64 && operation !== "close")
      return Promise.reject(new Error("Cloud cache queue is full."));
    const id = ++this.nextId;
    if (
      operation === "retain" ||
      operation === "activate" ||
      operation === "close"
    ) {
      this.lifecycleId = id;
      this.authority = null;
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, operation, payload });
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker.unref();
        reject(error);
      }
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.authority = null;
      this.closing = this.request("close", null)
        // An exited worker has already lost its connection. Terminate below
        // also handles failure during a queued close, without blocking reset.
        .catch((error: unknown) => {
          if (!this.failure) throw error;
        })
        .then(() => undefined)
        .finally(async () => {
          await this.worker.terminate();
        });
    }
    return this.closing;
  }
}
