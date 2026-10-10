import type { TurnEventEvent } from "@stella/contracts/turn-plane/owner-events";
import { APPEND_WINDOW_MAX_BYTES } from "../conversation-types.js";

/** Desktop keeps a connect card up about this long before giving up. */
export const CONNECT_CARD_WAIT_MS = 5 * 60_000;
export const CONNECT_CARD_POLL_MS = 2_000;
export const WAKE_REPORT_INLINE_MAX_BYTES = 512 * 1024;

/** A wake joins a running turn only while this much of its watchdog is left. */
export const WAKE_STEER_DEADLINE_MARGIN_MS = 60_000;

export const CHAT_WATCHDOG_MS = 5 * 60_000;
/**
 * While a chat turn runs, its alarm fires at least this often. The alarm is
 * what wakes a replaced object (a deploy, an eviction) so the wake can resume
 * the turn; without the beat a lost turn sat until its watchdog.
 */
export const CHAT_TURN_HEARTBEAT_MS = 15_000;
/** At most this many replacement isolates continue one chat turn. */
export const CHAT_RESUME_MAX = 2;
/** A turn older than this fails the way it always has instead of resuming. */
export const CHAT_RESUME_MAX_AGE_MS = 15 * 60_000;
/** Resuming this close to the watchdog would only buy a timeout mid-reply. */
export const CHAT_RESUME_DEADLINE_MARGIN_MS = 30_000;
/** `{ turnId, count }`: resumes spent by the turn under `turn`. */
export const CHAT_TURN_RESUME_KEY = "turnResume";
/** When the turn under `turn` was first claimed; bounds the resume age. */
export const CHAT_TURN_STARTED_AT_KEY = "turnStartedAt";
/**
 * The turn's model-gateway capability. A resumed turn presents the same token
 * so the gateway's per-capability ledger keeps counting the turn's spend.
 */
export const CHAT_TURN_MODEL_CAPABILITY_KEY = "turnModelCapability";

/** Poll the BuildSession this often while a CLI turn waits for its terminal. */
export const CLI_TURN_POLL_MS = 20_000;
/** A tool forward waits this long for a resumed turn to rebuild its tools. */
export const CLI_RUNTIME_WAIT_MS = 60_000;
/** A dispatch refused while the previous attempt unwinds is resent this often. */
export const CLI_DISPATCH_BUSY_RETRY_MS = 2_000;
export const CLI_DISPATCH_BUSY_RETRIES = 10;
/** Rows one CLI context block considers before its character budget. */
export const CLI_CONTEXT_ROW_LIMIT = 400;
/** The terminal's reply text as stored durably (DO values cap at 128 KiB). */
export const CLI_TERMINAL_DURABLE_TEXT_MAX = 24_000;

export const OWNER_PURGE_STALE_LEASE_GRACE_MS = 35_000;
export const LOCAL_TURN_LEASE_MS = 30 * 60_000;
export const LOCAL_TURN_CANCEL_GRACE_MS = 45_000;
// `userMessageJson` is nested inside the outer JSON request, so the Worker
// temporarily retains the request bytes, decoded outer text, parsed nested
// string, and parsed message. Keep this aligned with the outer ingress ceiling;
// larger messages need a streaming/direct-body protocol instead.
export const LOCAL_TURN_BEGIN_MAX_BYTES = 8 * 1024 * 1024;
export const LOCAL_TURN_FINISH_MAX_ROWS = 1_024;
export const LOCAL_TURN_FINISH_MAX_BYTES = APPEND_WINDOW_MAX_BYTES;
export const LOCAL_TURN_LEASE_KEY = "localTurnLease";
const LOCAL_TURN_RECEIPT_PREFIX = "localTurnReceipt:";
const LOCAL_CLIENT_MESSAGE_PREFIX = "localClientMessage:";
const CHAT_TURN_ADMISSION_PREFIX = "chatTurnAdmission:";
export const ORCHESTRATOR_FENCE_LEASE_RECEIPT_PREFIX =
  "orchestratorFenceLeaseReceipt:";
export const OWNER_FENCE_RUN_SLOT_PREFIX = "ownerFenceRunSlot:";
export const OWNER_FENCE_ID_HEADER = "x-stella-owner-fence-id";
export const localTurnReceiptKey = (turnId: string): string =>
  `${LOCAL_TURN_RECEIPT_PREFIX}${turnId}`;
export const localClientMessageKey = (clientMsgId: string): string =>
  `${LOCAL_CLIENT_MESSAGE_PREFIX}${clientMsgId}`;
export const chatTurnAdmissionKey = (clientMsgId: string): string =>
  `${CHAT_TURN_ADMISSION_PREFIX}${clientMsgId}`;
const TURN_EVENT_SEQ_PREFIX = "turnEventSeq:";
export const turnEventSeqKey = (turnId: string): string =>
  `${TURN_EVENT_SEQ_PREFIX}${turnId}`;
/**
 * Set once `conversation.created` has been handed to the owner. Adoption
 * (binding the owner) happens at the first verified contact — a socket
 * connect or a turn — but there is nothing to index until a turn exists,
 * so the event is the first turn's job whichever contact came first.
 */
export const CONVERSATION_PROJECTED_KEY = "conversationProjected";
/** Owner event batches the owner has not confirmed yet; the alarm retries them. */
export const OWNER_EVENT_BATCH_PREFIX = "ownerEventBatch:";
export const OWNER_EVENT_DEBT_RETRY_MS = 30_000;

export const ownerPurgeImportedLeaseKey = (leaseId: string): string =>
  `ownerPurgeImportedLease:${leaseId}`;
export const orchestratorFenceLeaseReceiptKey = (leaseId: string): string =>
  `${ORCHESTRATOR_FENCE_LEASE_RECEIPT_PREFIX}${leaseId}`;

export const TERMINAL_STATUS: Record<
  string,
  NonNullable<TurnEventEvent["terminalStatus"]>
> = {
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  timeout: "failed",
};

/** How many tool entries the live snapshot keeps. Newest win. */
export const LIVE_TOOL_LIMIT = 24;

/**
 * The user-facing text for each non-completed terminal, in one place: the
 * watchdog's retry ladder has to deliver the same words the transcript already
 * shows, and two copies of a sentence is how they stop matching.
 */
export const TERMINAL_NOTICE = {
  timeout: "This took longer than expected, so Stella stopped. Try again.",
  canceled: "Stopped.",
  failed: "Stella hit a problem answering this. Try again.",
} as const;

export const CLOUD_CONTEXT_NOTICE =
  "Stella couldn't load the required cloud context safely. Try again.";
