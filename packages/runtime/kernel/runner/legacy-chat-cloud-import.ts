import { createHash } from "node:crypto";
import type {
  LegacyChatCloudImportCandidate,
  LegacyChatCloudImportRecord,
  LegacyChatVisibleMessage,
  RuntimeStore,
} from "../storage/runtime-store.js";
import { forkDelayedCall } from "./cloud-effect-runtime.js";
import {
  CloudTranscriptAlreadyAdmittedError,
  type CloudTranscriptFinishRecord,
  type CloudTranscriptWriter,
} from "./cloud-transcript-write.js";

type CloudConversation = {
  conversationId: string;
};

type LegacyChatImportCloudApi = {
  getOwnershipMigrationStatus: () => Promise<{
    status: "pending" | "running" | "failed" | "complete";
  } | null>;
  getConversation: (
    conversationId: string,
  ) => Promise<CloudConversation | null>;
  createConversation: (args: {
    clientCreateId: string;
    title?: string;
  }) => Promise<CloudConversation>;
};

type LegacyChatImportStore = Pick<
  RuntimeStore,
  | "listLegacyChatCloudImportCandidates"
  | "getLegacyChatCloudImport"
  | "saveLegacyChatCloudImport"
  | "listLegacyChatVisibleMessages"
>;

export type LegacyChatCloudImporter = {
  resume: () => void;
  stop: () => void;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRY_MS = 60_000;
const MIGRATION_RETRY_MS = 15_000;
const MAX_CANDIDATES_PER_PASS = 100;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_FINISH_RECORDS = 1_000;
const MAX_FINISH_BYTES = 12 * 1024 * 1024;

type HistoricalTurn = {
  user: LegacyChatVisibleMessage;
  assistants: LegacyChatVisibleMessage[];
};

const stableDigest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

const stableCreateId = (localConversationId: string): string =>
  `legacy-chat:${stableDigest(localConversationId).slice(0, 52)}`;

const stableTurnId = (
  localConversationId: string,
  userMessageId: string,
): string =>
  `legacy:${stableDigest(localConversationId, userMessageId).slice(0, 56)}`;

const stableClientMessageId = (
  localConversationId: string,
  userMessageId: string,
): string =>
  `legacy:${stableDigest("message", localConversationId, userMessageId).slice(
    0,
    56,
  )}`;

const attachmentDescription = (payload: Record<string, unknown>): string => {
  if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) {
    return "";
  }
  const names = payload.attachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== "object") return "";
      const record = attachment as Record<string, unknown>;
      return typeof record.name === "string" ? record.name.trim() : "";
    })
    .filter(Boolean);
  return names.length
    ? `[Attachments: ${names.join(", ")}]`
    : `[${payload.attachments.length} attachment${
        payload.attachments.length === 1 ? "" : "s"
      }]`;
};

const visibleMessageText = (message: LegacyChatVisibleMessage): string => {
  const rawText =
    typeof message.payload.text === "string" ? message.payload.text : "";
  const attachmentText = attachmentDescription(message.payload);
  const combined =
    rawText.trim() && attachmentText
      ? `${rawText}\n\n${attachmentText}`
      : rawText || attachmentText || "[Empty historical message]";
  if (combined.length <= MAX_MESSAGE_CHARS) return combined;
  return `${combined.slice(
    0,
    MAX_MESSAGE_CHARS,
  )}\n\n[Historical message truncated during cloud migration.]`;
};

const historicalTurns = (
  messages: LegacyChatVisibleMessage[],
): HistoricalTurn[] => {
  const turns: HistoricalTurn[] = [];
  let current: HistoricalTurn | null = null;
  for (const message of messages) {
    if (message.type === "user_message") {
      current = { user: message, assistants: [] };
      turns.push(current);
      continue;
    }
    current?.assistants.push(message);
  }
  return turns;
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const buildUserMessageJson = (message: LegacyChatVisibleMessage): string =>
  JSON.stringify({
    role: "user",
    content: [{ type: "text", text: visibleMessageText(message) }],
    timestamp: message.timestamp,
  });

const buildAssistantRecord = (
  message: LegacyChatVisibleMessage,
  ordinal: number,
): CloudTranscriptFinishRecord => ({
  ordinal,
  role: "assistant",
  payloadJson: JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: visibleMessageText(message) }],
    api: "openai-completions",
    provider: "stella",
    model: "legacy-history",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: message.timestamp,
  }),
});

const buildFinishRecords = (
  messages: LegacyChatVisibleMessage[],
): CloudTranscriptFinishRecord[] => {
  const records: CloudTranscriptFinishRecord[] = [];
  let bytes = 0;
  let omitted = false;
  for (const message of messages) {
    const record = buildAssistantRecord(message, records.length);
    const recordBytes = new TextEncoder().encode(record.payloadJson).length;
    if (
      records.length >= MAX_FINISH_RECORDS - 1 ||
      bytes + recordBytes > MAX_FINISH_BYTES
    ) {
      omitted = true;
      break;
    }
    records.push(record);
    bytes += recordBytes;
  }
  if (omitted) {
    const notice = buildAssistantRecord(
      {
        id: "legacy-import-truncation",
        type: "assistant_message",
        timestamp: messages.at(-1)?.timestamp ?? Date.now(),
        payload: {
          text: "[Some historical response content was omitted because this turn exceeded the cloud migration safety limit.]",
        },
      },
      records.length,
    );
    records.push(notice);
  }
  return records;
};

const fallbackTitle = (messages: LegacyChatVisibleMessage[]): string => {
  const firstUser = messages.find((message) => message.type === "user_message");
  return firstUser ? visibleMessageText(firstUser).trim().slice(0, 80) : "";
};

export const createLegacyChatCloudImporter = (args: {
  deviceId: string;
  store: LegacyChatImportStore;
  cloudTranscript: Pick<CloudTranscriptWriter, "begin" | "finish">;
  cloud: LegacyChatImportCloudApi;
  hasAuthToken: () => boolean;
  onLog?: (
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}): LegacyChatCloudImporter => {
  const log = args.onLog ?? (() => {});
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  /** Cancel thunk for the pending retry-delay fiber (the old `clearTimeout`). */
  let cancelRetryDelay: (() => void) | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (cancelRetryDelay) cancelRetryDelay();
    cancelRetryDelay = forkDelayedCall(delayMs, () => {
      cancelRetryDelay = null;
      resume();
    });
  };

  const markSkipped = (
    candidate: LegacyChatCloudImportCandidate,
    detail: string,
  ): void => {
    args.store.saveLegacyChatCloudImport({
      localConversationId: candidate.conversationId,
      nextTurnIndex: 0,
      status: "skipped",
      detail,
    });
  };

  const resolveDestination = async (
    candidate: LegacyChatCloudImportCandidate,
    progress: LegacyChatCloudImportRecord | null,
    messages: LegacyChatVisibleMessage[],
  ): Promise<string | null> => {
    if (progress?.cloudConversationId) {
      return progress.cloudConversationId;
    }
    const existing = await args.cloud.getConversation(candidate.conversationId);
    if (existing) {
      markSkipped(candidate, "already-cloud-backed");
      return null;
    }
    // Stella's local conversation ids are ULIDs. A UUID here was minted by
    // the cloud and cached in SQLite by an older desktop build; if its server
    // row is now absent it may have been deleted, so never resurrect it.
    if (UUID_PATTERN.test(candidate.conversationId)) {
      markSkipped(candidate, "cloud-shaped-local-cache");
      return null;
    }
    const title = candidate.title.trim() || fallbackTitle(messages);
    const created = await args.cloud.createConversation({
      clientCreateId: stableCreateId(candidate.conversationId),
      ...(title ? { title } : {}),
    });
    args.store.saveLegacyChatCloudImport({
      localConversationId: candidate.conversationId,
      cloudConversationId: created.conversationId,
      nextTurnIndex: progress?.nextTurnIndex ?? 0,
      status: "pending",
    });
    return created.conversationId;
  };

  const importCandidate = async (
    candidate: LegacyChatCloudImportCandidate,
  ): Promise<void> => {
    const messages = args.store.listLegacyChatVisibleMessages(
      candidate.conversationId,
    );
    const turns = historicalTurns(messages);
    if (turns.length === 0) {
      markSkipped(candidate, "no-user-turns");
      return;
    }
    let progress = args.store.getLegacyChatCloudImport(
      candidate.conversationId,
    );
    const cloudConversationId = await resolveDestination(
      candidate,
      progress,
      messages,
    );
    if (!cloudConversationId) return;
    progress = args.store.getLegacyChatCloudImport(candidate.conversationId);
    let nextTurnIndex = Math.min(progress?.nextTurnIndex ?? 0, turns.length);
    while (!stopped && nextTurnIndex < turns.length) {
      const turn = turns[nextTurnIndex]!;
      const records = buildFinishRecords(turn.assistants);
      const localTurnId = stableTurnId(candidate.conversationId, turn.user.id);
      const clientMsgId = stableClientMessageId(
        candidate.conversationId,
        turn.user.id,
      );
      let leaseToken: string | null = null;
      try {
        const begin = await args.cloudTranscript.begin({
          conversationId: cloudConversationId,
          localTurnId,
          clientMsgId,
          userMessageJson: buildUserMessageJson(turn.user),
          recovery: {
            kind: "precomputed-finish",
            records,
            phase: "completed",
          },
        });
        leaseToken = begin.leaseToken;
      } catch (error) {
        if (!(error instanceof CloudTranscriptAlreadyAdmittedError)) {
          throw error;
        }
      }
      if (leaseToken) {
        const finish = await args.cloudTranscript.finish({
          conversationId: cloudConversationId,
          localTurnId,
          leaseToken,
          records,
          phase: "completed",
        });
        if (!finish.queued) {
          throw new Error(`Historical cloud finish rejected: ${finish.reason}`);
        }
      }
      nextTurnIndex += 1;
      args.store.saveLegacyChatCloudImport({
        localConversationId: candidate.conversationId,
        cloudConversationId,
        nextTurnIndex,
        status: nextTurnIndex === turns.length ? "complete" : "pending",
      });
    }
    if (nextTurnIndex === turns.length) {
      log("info", "legacy_chat_cloud_import_complete", {
        localConversationId: candidate.conversationId,
        cloudConversationId,
        turns: turns.length,
      });
    }
  };

  const run = async (): Promise<void> => {
    if (stopped || !args.hasAuthToken()) return;
    const ownershipMigration = await args.cloud.getOwnershipMigrationStatus();
    if (
      ownershipMigration?.status === "pending" ||
      ownershipMigration?.status === "running"
    ) {
      schedule(MIGRATION_RETRY_MS);
      return;
    }
    if (ownershipMigration?.status === "failed") {
      schedule(RETRY_MS);
      return;
    }
    while (!stopped && args.hasAuthToken()) {
      const candidates = args.store.listLegacyChatCloudImportCandidates(
        MAX_CANDIDATES_PER_PASS,
      );
      if (candidates.length === 0) return;
      for (const candidate of candidates) {
        if (stopped || !args.hasAuthToken()) return;
        await importCandidate(candidate);
      }
    }
  };

  const resume = (): void => {
    if (stopped || inFlight || !args.hasAuthToken()) return;
    if (cancelRetryDelay) {
      cancelRetryDelay();
      cancelRetryDelay = null;
    }
    inFlight = run()
      .catch((error) => {
        log("error", "legacy_chat_cloud_import_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        schedule(RETRY_MS);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    resume,
    stop: () => {
      stopped = true;
      if (cancelRetryDelay) {
        cancelRetryDelay();
        cancelRetryDelay = null;
      }
    },
  };
};
