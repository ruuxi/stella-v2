import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionPlacementInbox } from "../../host/execution-placement-bridge.js";
import { createDesktopDatabase } from "../storage/database.js";
import { SessionStore } from "../storage/session-store.js";
import {
  getPlacementCancellation,
  persistPlacementCancellation,
} from "./execution-placement-local-ownership.js";

describe("execution placement durable local ownership", () => {
  test("a pre-cancel tombstone survives a worker connection restart", () => {
    const root = mkdtempSync(join(tmpdir(), "stella-placement-cancel-"));
    const hostDatabase = createDesktopDatabase(root);
    const workerDatabase = createDesktopDatabase(root);
    try {
      // The host owns this table through a separate connection to the exact
      // same stella.sqlite file used by the worker SessionStore.
      new ExecutionPlacementInbox(hostDatabase);
      const firstWorker = new SessionStore(workerDatabase);
      persistPlacementCancellation({
        store: firstWorker,
        kind: "chat",
        executionId: "placement-chat:0123456789abcdef",
        reason: "Canceled before worker restart.",
      });

      expect(
        hostDatabase
          .prepare(
            `SELECT value FROM settings
             WHERE key = ?`,
          )
          .get(
            "execution-placement.cancel.v1:chat:placement-chat:0123456789abcdef",
          ),
      ).toEqual({ value: "Canceled before worker restart." });

      workerDatabase.close();
      const restartedDatabase = createDesktopDatabase(root);
      try {
        const restartedWorker = new SessionStore(restartedDatabase);
        expect(
          getPlacementCancellation({
            store: restartedWorker,
            kind: "chat",
            executionId: "placement-chat:0123456789abcdef",
          }),
        ).toBe("Canceled before worker restart.");
        expect(
          getPlacementCancellation({
            store: restartedWorker,
            kind: "agent",
            executionId: "placement-agent:0123456789abcdef",
          }),
        ).toBeNull();
      } finally {
        restartedDatabase.close();
      }
    } finally {
      hostDatabase.close();
      try {
        workerDatabase.close();
      } catch {
        // The worker connection was deliberately closed before restart.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
