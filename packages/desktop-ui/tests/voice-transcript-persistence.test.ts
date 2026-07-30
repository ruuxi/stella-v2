import { describe, expect, test } from "bun:test";
import {
  persistVoiceTranscriptWithRetry,
  VoiceTranscriptPersistenceQueue,
} from "../src/features/voice/runtime/voice-transcript-persistence";

describe("voice transcript durable invoke", () => {
  test("retries the same event id until main acknowledges SQLite admission", async () => {
    const attempts: Array<{
      eventId: string;
      timestamp: number;
      text: string;
    }> = [];
    const delays: number[] = [];
    const payload = {
      conversationId: "conversation-1",
      eventId: "voice-session-1:7",
      timestamp: 123_456,
      role: "user" as const,
      text: "Keep this",
    };

    const result = await persistVoiceTranscriptWithRetry(
      async (candidate) => {
        attempts.push({
          eventId: candidate.eventId,
          timestamp: candidate.timestamp,
          text: candidate.text,
        });
        if (attempts.length < 3) {
          throw new Error("runtime restarting");
        }
        return { ok: true };
      },
      payload,
      {
        retryBaseMs: 5,
        retryMaxMs: 20,
        maxAttempts: 3,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(attempts).toEqual([
      {
        eventId: "voice-session-1:7",
        timestamp: 123_456,
        text: "Keep this",
      },
      {
        eventId: "voice-session-1:7",
        timestamp: 123_456,
        text: "Keep this",
      },
      {
        eventId: "voice-session-1:7",
        timestamp: 123_456,
        text: "Keep this",
      },
    ]);
    expect(delays).toEqual([5, 10]);
  });

  test("dispatches the first IPC before enqueue returns and preserves FIFO", async () => {
    const queue = new VoiceTranscriptPersistenceQueue();
    const dispatched: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persist = async (candidate: { eventId: string }) => {
      dispatched.push(candidate.eventId);
      if (candidate.eventId === "voice:1") await firstGate;
      return { ok: true as const };
    };
    const base = {
      conversationId: "conversation-1",
      timestamp: 123_456,
      role: "user" as const,
      text: "Keep this",
    };

    const first = queue.enqueue(persist, {
      ...base,
      eventId: "voice:1",
    });
    expect(dispatched).toEqual(["voice:1"]);
    const second = queue.enqueue(persist, {
      ...base,
      eventId: "voice:2",
    });
    expect(dispatched).toEqual(["voice:1"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(dispatched).toEqual(["voice:1", "voice:2"]);
  });
});
