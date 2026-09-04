import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { CloudConversationCacheStore } from "./cloud-conversation-cache-store.js";

const port = parentPort;
if (!port) throw new Error("Cloud cache worker requires a parent port.");
const db = new DatabaseSync(
  workerData.databasePath,
) as unknown as SqliteDatabase;
// Main has already initialized the shared database. Only connection-local
// pragmas belong here; rerunning migrations would compete with ordinary chat.
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
const store = new CloudConversationCacheStore(db);
port.on("message", ({ id, operation, payload }) => {
  try {
    let result: unknown;
    switch (operation) {
      case "retain":
        result = store.retainAccountScope(payload);
        break;
      case "activate":
        result = store.activateAuthority(payload);
        break;
      case "read":
        result = store.read(payload);
        break;
      case "replace":
        result = store.replace(payload);
        break;
      case "purge":
        result = store.purgeConversation(payload);
        break;
      case "close":
        db.close();
        port.postMessage({ id, result: null, authority: null });
        port.close();
        return;
      default:
        throw new Error("Unknown cloud cache operation.");
    }
    port.postMessage({ id, result, authority: store.getActiveAuthority() });
  } catch (error) {
    port.postMessage({
      id,
      error:
        error instanceof Error
          ? error.message
          : "Cloud cache operation failed.",
    });
  }
});
