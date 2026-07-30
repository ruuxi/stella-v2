import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDesktopDatabase } from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { VoiceTranscriptInbox } from "./voice-transcript-inbox.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("main-process voice transcript inbox", () => {
  test("admits synchronously, dedupes exact replay, and survives restart", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-voice-inbox-"),
    );
    temporaryRoots.push(temporaryRoot);
    const databasePath = path.join(temporaryRoot, "stella.sqlite");
    const payload = {
      conversationId: "conversation-1",
      eventId: "voice-session-1:9",
      timestamp: 123_456,
      role: "assistant" as const,
      text: "Durably keep this",
      uiVisibility: "hidden" as const,
    };

    const firstDatabase = new Database(databasePath);
    initializeDesktopDatabase(firstDatabase as unknown as SqliteDatabase);
    const first = new VoiceTranscriptInbox(
      firstDatabase as unknown as SqliteDatabase,
    );
    expect(first.admit(payload)).toEqual({ replayed: false });
    expect(first.admit(payload)).toEqual({ replayed: true });
    expect(() =>
      first.admit({ ...payload, text: "Different payload" }),
    ).toThrow("eventId was reused");
    firstDatabase.close();

    const recoveredDatabase = new Database(databasePath);
    initializeDesktopDatabase(recoveredDatabase as unknown as SqliteDatabase);
    const recovered = new VoiceTranscriptInbox(
      recoveredDatabase as unknown as SqliteDatabase,
    );
    expect(recovered.list()).toEqual([payload]);
    recovered.delete(payload.eventId);
    expect(recovered.list()).toEqual([]);
    recoveredDatabase.close();
  });
});
