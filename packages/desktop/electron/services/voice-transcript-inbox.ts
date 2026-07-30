import type { RuntimeVoiceTranscriptPayload } from "@stella/contracts/protocol";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

/**
 * Small synchronous adapter around the main-process operational inbox. It is
 * independent of Electron and node:sqlite so its crash/restart contract can be
 * exercised against any compatible SQLite implementation.
 */
export class VoiceTranscriptInbox {
  constructor(private readonly database: SqliteDatabase) {}

  admit(payload: RuntimeVoiceTranscriptPayload): { replayed: boolean } {
    const eventId = payload.eventId.trim();
    if (
      !eventId ||
      !payload.conversationId.trim() ||
      !Number.isSafeInteger(payload.timestamp) ||
      payload.timestamp < 0 ||
      !payload.text.trim() ||
      (payload.role !== "user" && payload.role !== "assistant")
    ) {
      throw new Error("Invalid voice transcript persistence payload.");
    }
    const payloadJson = JSON.stringify({ ...payload, eventId });
    const prior = this.database
      .prepare(
        `SELECT payload_json AS payloadJson
           FROM voice_transcript_inbox WHERE event_id = ?`,
      )
      .get(eventId) as { payloadJson?: unknown } | undefined;
    if (prior) {
      if (prior.payloadJson !== payloadJson) {
        throw new Error(
          "Voice transcript eventId was reused with new payload.",
        );
      }
      return { replayed: true };
    }
    this.database
      .prepare(
        `INSERT INTO voice_transcript_inbox (
           event_id, payload_json, created_at
         ) VALUES (?, ?, ?)`,
      )
      .run(eventId, payloadJson, Date.now());
    return { replayed: false };
  }

  list(limit = 100): RuntimeVoiceTranscriptPayload[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json AS payloadJson
           FROM voice_transcript_inbox
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      payloadJson?: unknown;
    }>;
    return rows.flatMap((row) => {
      if (typeof row.payloadJson !== "string") return [];
      try {
        return [JSON.parse(row.payloadJson) as RuntimeVoiceTranscriptPayload];
      } catch {
        return [];
      }
    });
  }

  delete(eventId: string): void {
    this.database
      .prepare("DELETE FROM voice_transcript_inbox WHERE event_id = ?")
      .run(eventId);
  }
}
