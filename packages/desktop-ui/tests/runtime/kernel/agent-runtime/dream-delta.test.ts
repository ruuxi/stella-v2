import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDreamDeltaTranscript,
  formatDeltaEntry,
} from "@stella/runtime/kernel/agent-runtime/dream-delta";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import { containsLoneUnicodeSurrogate } from "@stella/runtime/kernel/memory/dream-storage";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const contexts = createSqliteTestContextFactory(
  "stella-dream-delta",
  (db) => new SessionStore(db),
);

afterEach(() => contexts.cleanup());

describe("Dream orchestrator delta", () => {
  it("derives deterministic user, assistant, and model-visible task entries", () => {
    const messages = [
      { timestamp: 10, role: "user" as const, content: "Remember alpha" },
      { timestamp: 11, role: "assistant" as const, content: "I will." },
      {
        timestamp: 12,
        role: "custom" as const,
        content: "Task completed",
        customMessage: {
          customType: "runtime.task_lifecycle",
          content: [{ type: "text", text: "Task completed" }],
          display: false,
        },
      },
      {
        timestamp: 13,
        role: "custom" as const,
        content: "private noise",
        customMessage: {
          customType: "runtime.private_task_lifecycle",
          content: [{ type: "text", text: "private noise" }],
          display: false,
        },
      },
    ];
    const first = buildDreamDeltaTranscript(messages, 9);
    const second = buildDreamDeltaTranscript(messages, 9);
    expect(second).toEqual(first);
    expect(first.transcript).toContain("[User]\nRemember alpha");
    expect(first.transcript).toContain("[Assistant]\nI will.");
    expect(first.transcript).toContain("[Task report]\nTask completed");
    expect(first.transcript).not.toContain("private noise");
    expect(first.coveredThroughTs).toBe(12);
  });

  it("rolls coverage below an excluded equal-timestamp tie", () => {
    const delta = buildDreamDeltaTranscript(
      [
        { timestamp: 100, role: "user", content: "a".repeat(20) },
        { timestamp: 101, role: "assistant", content: "b".repeat(20) },
        { timestamp: 101, role: "user", content: "c".repeat(20) },
      ],
      99,
      { maxChars: 35, messageMaxChars: 100 },
    );
    expect(delta.truncated).toBe(true);
    expect(Array.from(delta.transcript).length).toBeLessThanOrEqual(35);
    expect(delta.coveredThroughTs).toBe(100);
    expect(delta.newestMessageTs).toBe(101);
  });

  it("keeps Unicode message truncation well formed", () => {
    const entry = formatDeltaEntry({
      timestamp: 1,
      role: "user",
      content: "😀".repeat(20),
    });
    const delta = buildDreamDeltaTranscript(
      [{ timestamp: 1, role: "user", content: entry ?? "" }],
      0,
      { maxChars: 100, messageMaxChars: 20 },
    );
    expect(containsLoneUnicodeSurrogate(delta.transcript)).toBe(false);
    expect(delta.transcript).toContain("…[truncated]");
  });

  it("projects raw durable history and excludes compaction overlays", () => {
    const { rootPath, store } = contexts.create();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-overlay",
      agentType: "orchestrator",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_000,
      role: "user",
      content: "raw user fact",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_001,
      role: "assistant",
      content: "raw assistant answer",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_002,
      role: "user",
      content: "kept tail",
    });
    const before = store.loadRawThreadMessagesWithEntryTypes(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "OVERLAY SUMMARY MUST NOT ENTER DELTA",
      fromEntryId: before[0]!.entryId,
      toEntryId: before[1]!.entryId,
      tokensBefore: 100,
      summaryValidation: { middleTokens: 80 },
      timestamp: 2_000,
    });
    const rebuilt = store.loadThreadMessages(threadId);
    const raw = store.loadRawThreadMessagesWithEntryTypes(threadId);
    expect(rebuilt.some((message) => message.content.includes("OVERLAY"))).toBe(
      true,
    );
    expect(raw.map((message) => message.content)).toEqual([
      "raw user fact",
      "raw assistant answer",
      "kept tail",
    ]);
    expect(buildDreamDeltaTranscript(raw, 0).transcript).not.toContain(
      "OVERLAY SUMMARY",
    );

    // Prove the method is restart-stable, not an in-memory projection.
    const reloadedDb = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5_000,
    });
    initializeDesktopDatabase(reloadedDb);
    const reloaded = new SessionStore(reloadedDb);
    expect(
      reloaded
        .loadRawThreadMessagesWithEntryTypes(threadId)
        .map((message) => message.content),
    ).toEqual(["raw user fact", "raw assistant answer", "kept tail"]);
    reloadedDb.close();
  });
});
