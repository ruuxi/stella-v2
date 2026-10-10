import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { JournalRecord } from "@stella/contracts/conversation-protocol";
import type { CloudAttachment } from "./cloud-composer-store";
import type { DesktopExecutionTarget } from "../execution-placement/execution-target-store";

/** Exact authority that may read, mutate, or replay one persisted send. */
export type CloudConversationOutboxAuthority = {
  accountScope: string;
  ownerGeneration: string;
};

export type PendingCloudTurnSubmission = {
  /**
   * Immutable conversation authority from the first send. On the desktop a
   * send with no conversation open mints this id itself, so the first turn
   * creates the conversation under an id the client already knows. `null`
   * survives only on the web shell, where placement requires an open
   * conversation. It must not be replaced after admission, or a retry would
   * change payloads.
   */
  requestedConversationId: string | null;
  /** Exact model-visible prompt; retries must not redecorate it. */
  prompt: string;
  /** Exact image paths sent with the idempotent mutation. */
  imagePaths: readonly string[];
  /** Immutable composer snapshot used for guarded post-success clearing. */
  attachments: readonly CloudAttachment[];
  /** Frozen reply-language hint; null preserves the API's default behavior. */
  locale: string | null;
  /** Frozen explicit provider/model route for idempotent retries. */
  execution: CloudExecutionSelection | null;
  /** Frozen placement choice. Missing only on outbox rows from older builds. */
  executionTarget?: DesktopExecutionTarget;
};

export type PendingPrompt = {
  /** Immutable auth subject scope that owns this optimistic row. */
  accountScope: string;
  /** Immutable owner-lifecycle generation that admitted this send. */
  ownerGeneration: string;
  clientMsgId: string;
  text: string;
  createdAtMs: number;
  /** Null until admission answers; then the canonical display conversation. */
  conversationId: string | null;
  /** Null until admission answers. */
  turnId: string | null;
  /** Placement identity; also becomes the canonical journal clientMsgId. */
  dispatchId: string | null;
  /** Stop pressed before placement admission returned its dispatch id. */
  cancelRequested: boolean;
  /** Set when the send failed; the row stays visible with a readable reason. */
  error: string | null;
  /** A transport-ambiguous failure is re-armed once on the next process load. */
  retryOnNextActivation: boolean;
  /** True while the exact retry payload is present in synchronous storage. */
  durable: boolean;
  /** True after exact canonical admission/terminal evidence removed storage. */
  deliveryAcknowledged: boolean;
  /** Frozen wire payload reused byte-for-byte by Retry. */
  submission: PendingCloudTurnSubmission;
};

export type CloudConversationOutboxStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

const STORAGE_PREFIX = "stella:cloud-conversation-outbox:v1:";
const MAX_OUTBOX_ENTRIES = 32;
const MAX_ENTRY_BYTES = 256_000;
const MAX_SCOPE_CHARS = 512;
const MAX_GENERATION_CHARS = 512;
const MAX_CONVERSATION_ID_CHARS = 512;
const MAX_CLIENT_MSG_ID_CHARS = 64;
const MAX_PROMPT_CHARS = 8_000;
const MAX_ERROR_CHARS = 2_000;
const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

type PersistedPendingPrompt = Omit<PendingPrompt, "durable">;

type PersistedEnvelope = {
  version: 1;
  entry: PersistedPendingPrompt;
};

const isBoundedString = (
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  value.length <= maximum;

const isNullableBoundedString = (
  value: unknown,
  maximum: number,
): value is string | null => value === null || isBoundedString(value, maximum);

const EXECUTION_ENGINES = new Set(["stella", "anthropic", "chatgpt"]);
const REASONING_EFFORTS = new Set([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const isExecution = (value: unknown): value is CloudExecutionSelection => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isBoundedString(candidate.engine, 32) &&
    EXECUTION_ENGINES.has(candidate.engine) &&
    candidate.provider === candidate.engine &&
    isBoundedString(candidate.model, 192) &&
    isBoundedString(candidate.reasoningEffort, 32) &&
    REASONING_EFFORTS.has(candidate.reasoningEffort)
  );
};

const isAttachment = (value: unknown): value is CloudAttachment => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isBoundedString(candidate.path, 512) &&
    isBoundedString(candidate.name, 512) &&
    typeof candidate.sizeBytes === "number" &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0 &&
    (candidate.contentType === undefined ||
      isBoundedString(candidate.contentType, 128))
  );
};

const isExecutionTarget = (value: unknown): value is DesktopExecutionTarget => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.mode === "automatic" ||
    candidate.mode === "cloud" ||
    (candidate.mode === "device" && isBoundedString(candidate.deviceId, 256))
  );
};

const isSubmission = (value: unknown): value is PendingCloudTurnSubmission => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNullableBoundedString(
      candidate.requestedConversationId,
      MAX_CONVERSATION_ID_CHARS,
    ) &&
    isBoundedString(candidate.prompt, MAX_PROMPT_CHARS) &&
    Array.isArray(candidate.imagePaths) &&
    candidate.imagePaths.length <= 4 &&
    candidate.imagePaths.every((path) => isBoundedString(path, 512)) &&
    Array.isArray(candidate.attachments) &&
    candidate.attachments.length <= 32 &&
    candidate.attachments.every(isAttachment) &&
    isNullableBoundedString(candidate.locale, 64) &&
    (candidate.execution === null || isExecution(candidate.execution)) &&
    (candidate.executionTarget === undefined ||
      isExecutionTarget(candidate.executionTarget))
  );
};

const parseEnvelope = (raw: string): PendingPrompt | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== 1 || !envelope.entry) return null;
  const candidate = envelope.entry as Record<string, unknown>;
  if (
    !isBoundedString(candidate.accountScope, MAX_SCOPE_CHARS) ||
    !isBoundedString(candidate.ownerGeneration, MAX_GENERATION_CHARS) ||
    !isBoundedString(candidate.clientMsgId, MAX_CLIENT_MSG_ID_CHARS) ||
    !CLIENT_MSG_ID_PATTERN.test(candidate.clientMsgId) ||
    !isBoundedString(candidate.text, MAX_PROMPT_CHARS) ||
    typeof candidate.createdAtMs !== "number" ||
    !Number.isSafeInteger(candidate.createdAtMs) ||
    candidate.createdAtMs < 0 ||
    !isNullableBoundedString(
      candidate.conversationId,
      MAX_CONVERSATION_ID_CHARS,
    ) ||
    !isNullableBoundedString(candidate.turnId, 512) ||
    !isNullableBoundedString(candidate.dispatchId, 512) ||
    typeof candidate.cancelRequested !== "boolean" ||
    typeof candidate.retryOnNextActivation !== "boolean" ||
    candidate.deliveryAcknowledged !== false ||
    !isNullableBoundedString(candidate.error, MAX_ERROR_CHARS) ||
    !isSubmission(candidate.submission)
  ) {
    return null;
  }
  return {
    accountScope: candidate.accountScope,
    ownerGeneration: candidate.ownerGeneration,
    clientMsgId: candidate.clientMsgId,
    text: candidate.text,
    createdAtMs: candidate.createdAtMs,
    conversationId: candidate.conversationId,
    turnId: candidate.turnId,
    dispatchId: candidate.dispatchId,
    cancelRequested: candidate.cancelRequested,
    error: candidate.error,
    retryOnNextActivation: candidate.retryOnNextActivation,
    durable: true,
    deliveryAcknowledged: false,
    submission: candidate.submission,
  };
};

const persistedEntry = (entry: PendingPrompt): PersistedPendingPrompt => ({
  accountScope: entry.accountScope,
  ownerGeneration: entry.ownerGeneration,
  clientMsgId: entry.clientMsgId,
  text: entry.text,
  createdAtMs: entry.createdAtMs,
  conversationId: entry.conversationId,
  turnId: entry.turnId,
  dispatchId: entry.dispatchId,
  cancelRequested: entry.cancelRequested,
  error: entry.error,
  retryOnNextActivation: entry.retryOnNextActivation,
  // Persisted rows are, by definition, still awaiting acknowledgement.
  deliveryAcknowledged: false,
  submission: entry.submission,
});

const encodedKeyPart = (value: string): string => encodeURIComponent(value);

/**
 * One record per localStorage key prevents two browser tabs from losing each
 * other's sends through a read/modify/write of one shared JSON array.
 */
export const cloudConversationOutboxStorageKey = (
  entry: Pick<
    PendingPrompt,
    "accountScope" | "ownerGeneration" | "clientMsgId" | "submission"
  >,
): string =>
  `${STORAGE_PREFIX}${encodedKeyPart(entry.accountScope)}/${encodedKeyPart(
    entry.ownerGeneration,
  )}/${
    entry.submission.requestedConversationId === null
      ? "new"
      : `id-${encodedKeyPart(entry.submission.requestedConversationId)}`
  }/${entry.clientMsgId}`;

const authorityMatches = (
  entry: PendingPrompt,
  authority: CloudConversationOutboxAuthority,
): boolean =>
  entry.accountScope === authority.accountScope &&
  entry.ownerGeneration === authority.ownerGeneration;

const clientIdentityMatches = (
  entry: PendingPrompt,
  authority: CloudConversationOutboxAuthority,
  clientMsgId: string,
): boolean =>
  authorityMatches(entry, authority) && entry.clientMsgId === clientMsgId;

const frozenIntentJson = (entry: PendingPrompt): string =>
  JSON.stringify({
    accountScope: entry.accountScope,
    ownerGeneration: entry.ownerGeneration,
    clientMsgId: entry.clientMsgId,
    text: entry.text,
    submission: entry.submission,
  });

const serialize = (entry: PendingPrompt): string => {
  const raw = JSON.stringify({
    version: 1,
    entry: persistedEntry(entry),
  } satisfies PersistedEnvelope);
  if (!parseEnvelope(raw)) {
    throw new Error("That message cannot be saved for reliable delivery.");
  }
  if (raw.length > MAX_ENTRY_BYTES) {
    throw new Error("That message is too large to save for reliable delivery.");
  }
  return raw;
};

const browserStorage = (): CloudConversationOutboxStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const storageKeys = (storage: CloudConversationOutboxStorage): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
};

export type CloudConversationOutbox = ReturnType<
  typeof createCloudConversationOutbox
>;

export const createCloudConversationOutbox = (
  getStorage: () => CloudConversationOutboxStorage | null,
) => {
  const requireStorage = (): CloudConversationOutboxStorage => {
    const storage = getStorage();
    if (!storage) {
      throw new Error(
        "Reliable message storage is unavailable. This message was not sent.",
      );
    }
    return storage;
  };

  const readAll = (): PendingPrompt[] => {
    const storage = requireStorage();
    const entries: PendingPrompt[] = [];
    for (const key of storageKeys(storage)) {
      const raw = storage.getItem(key);
      const entry = raw === null ? null : parseEnvelope(raw);
      if (!entry || cloudConversationOutboxStorageKey(entry) !== key) {
        // Corrupt or key-swapped records are never replayed under inferred
        // authority. Cleanup is synchronous and must succeed before sending.
        storage.removeItem(key);
        continue;
      }
      entries.push(entry);
    }
    return entries;
  };

  return {
    /** Purges every other account/generation before hydrating this authority. */
    activate(authority: CloudConversationOutboxAuthority): PendingPrompt[] {
      const storage = requireStorage();
      const current: PendingPrompt[] = [];
      const byClientMsgId = new Map<string, PendingPrompt>();
      for (const entry of readAll()) {
        if (authorityMatches(entry, authority)) {
          if (byClientMsgId.has(entry.clientMsgId)) {
            throw new Error(
              "Reliable message storage contains conflicting prior deliveries.",
            );
          }
          byClientMsgId.set(entry.clientMsgId, entry);
          current.push(entry);
        } else {
          storage.removeItem(cloudConversationOutboxStorageKey(entry));
        }
      }
      return current.sort((a, b) => a.createdAtMs - b.createdAtMs);
    },

    /** Account-switch fence used before the new generation query resolves. */
    purgeOtherAccounts(accountScope: string): void {
      const storage = requireStorage();
      for (const entry of readAll()) {
        if (entry.accountScope !== accountScope) {
          storage.removeItem(cloudConversationOutboxStorageKey(entry));
        }
      }
    },

    /** Synchronous commit point. Callers may invoke the network only after it. */
    enqueue(entry: PendingPrompt): PendingPrompt {
      const storage = requireStorage();
      const all = readAll();
      const collision = all.find(
        (candidate) =>
          authorityMatches(candidate, entry) &&
          candidate.clientMsgId === entry.clientMsgId,
      );
      if (collision) {
        if (frozenIntentJson(collision) !== frozenIntentJson(entry)) {
          throw new Error(
            "That reliable message id is already bound to a different request.",
          );
        }
        return collision;
      }
      if (all.length >= MAX_OUTBOX_ENTRIES) {
        throw new Error(
          "Too many messages are waiting for reliable delivery. Retry after they finish.",
        );
      }
      const durable = {
        ...entry,
        durable: true,
        deliveryAcknowledged: false,
      };
      storage.setItem(
        cloudConversationOutboxStorageKey(durable),
        serialize(durable),
      );
      return durable;
    },

    /**
     * Updates an existing exact-authority record. Missing means a stale async
     * callback arrived after retirement; it must not recreate the outbox row.
     */
    update(entry: PendingPrompt): PendingPrompt | null {
      const storage = requireStorage();
      const key = cloudConversationOutboxStorageKey(entry);
      const existingRaw = storage.getItem(key);
      const existing = existingRaw === null ? null : parseEnvelope(existingRaw);
      if (
        !existing ||
        !clientIdentityMatches(existing, entry, entry.clientMsgId) ||
        frozenIntentJson(existing) !== frozenIntentJson(entry)
      ) {
        return null;
      }
      const durable = {
        ...entry,
        durable: true,
        deliveryAcknowledged: false,
      };
      storage.setItem(key, serialize(durable));
      return durable;
    },

    /** Exact-authority removal for canonical acknowledgement or user discard. */
    remove(entry: PendingPrompt): boolean {
      const storage = requireStorage();
      const key = cloudConversationOutboxStorageKey(entry);
      const existingRaw = storage.getItem(key);
      const existing = existingRaw === null ? null : parseEnvelope(existingRaw);
      if (
        !existing ||
        !clientIdentityMatches(existing, entry, entry.clientMsgId) ||
        frozenIntentJson(existing) !== frozenIntentJson(entry)
      ) {
        return false;
      }
      storage.removeItem(key);
      return true;
    },

    /** Test/acceptance visibility; production replay uses `activate`. */
    list(): PendingPrompt[] {
      return readAll().sort((a, b) => a.createdAtMs - b.createdAtMs);
    },
  };
};

let testStorage: CloudConversationOutboxStorage | null | undefined;

const selectedStorage = (): CloudConversationOutboxStorage | null =>
  testStorage === undefined ? browserStorage() : testStorage;

export const cloudConversationOutbox =
  createCloudConversationOutbox(selectedStorage);

/** Unit tests install a real synchronous Storage-shaped adapter explicitly. */
export const setCloudConversationOutboxStorageForTests = (
  storage: CloudConversationOutboxStorage | null | undefined,
): void => {
  testStorage = storage;
};

// ---------------------------------------------------------------- pending

const pendingListeners = new Set<() => void>();
let pending: readonly PendingPrompt[] = [];
const EMPTY_PENDING: readonly PendingPrompt[] = [];
const inFlightPending = new Set<string>();
let activePendingAuthorityKey: string | null = null;
let activePendingAuthorityReady = false;

const authorityKey = (authority: CloudConversationOutboxAuthority): string =>
  `${authority.accountScope}\u0000${authority.ownerGeneration}`;

const pendingKey = (
  authority: CloudConversationOutboxAuthority,
  clientMsgId: string,
): string => `${authorityKey(authority)}\u0000${clientMsgId}`;

const ownsPending = (
  entry: PendingPrompt,
  authority: CloudConversationOutboxAuthority,
): boolean =>
  entry.accountScope === authority.accountScope &&
  entry.ownerGeneration === authority.ownerGeneration;

const reliableStorageError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "Reliable message storage is unavailable. This message was not sent.";

const frozenSubmission = (
  submission: PendingCloudTurnSubmission,
): PendingCloudTurnSubmission =>
  Object.freeze({
    requestedConversationId: submission.requestedConversationId,
    prompt: submission.prompt,
    imagePaths: Object.freeze([...submission.imagePaths]),
    attachments: Object.freeze(
      submission.attachments.map((attachment) =>
        Object.freeze({ ...attachment }),
      ),
    ),
    locale: submission.locale,
    execution: submission.execution
      ? Object.freeze({ ...submission.execution })
      : null,
  });

const emitPending = (next: readonly PendingPrompt[]): void => {
  pending = next;
  for (const listener of pendingListeners) listener();
};

/**
 * Optimistic prompts. A prompt is echoed the instant the user sends it and
 * replaced by the canonical journal row when it arrives — resolved on either
 * `clientMsgId` (the key the mutation threads to the DO) or `turnId` (which
 * the mutation returns directly). Two keys because either one alone leaves a
 * ghost bubble if a link in the chain drops its field.
 */
export const pendingPrompts = {
  subscribe(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => pendingListeners.delete(listener);
  },
  getSnapshot(): readonly PendingPrompt[] {
    return pending;
  },
  add(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    text: string,
    conversationId: string | null,
    submission: PendingCloudTurnSubmission,
  ): PendingPrompt {
    const base: PendingPrompt = {
      ...authority,
      clientMsgId,
      text,
      createdAtMs: Date.now(),
      conversationId,
      turnId: null,
      dispatchId: null,
      cancelRequested: false,
      error: null,
      retryOnNextActivation: false,
      durable: false,
      deliveryAcknowledged: false,
      submission: frozenSubmission(submission),
    };
    let entry = base;
    if (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === authorityKey(authority)
    ) {
      try {
        entry = cloudConversationOutbox.enqueue(base);
      } catch (error) {
        entry = { ...base, error: reliableStorageError(error) };
      }
    } else {
      entry = {
        ...base,
        error:
          "Stella is still verifying reliable delivery for this account. This message was not sent.",
      };
    }
    emitPending([...pending, entry]);
    return entry;
  },
  bindDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    dispatchId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({ ...entry, dispatchId }));
  },
  requestCancel(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      cancelRequested: true,
    }));
  },
  find(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): PendingPrompt | null {
    return (
      pending.find(
        (entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId,
      ) ?? null
    );
  },
  /** The mutation answered: we now know where the prompt landed. */
  bind(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    conversationId: string,
    turnId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      conversationId,
      turnId,
    }));
  },
  fail(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    message: string,
    retryOnNextActivation = false,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      error: message,
      retryOnNextActivation,
    }));
  },
  drop(authority: CloudConversationOutboxAuthority, clientMsgId: string): void {
    const found = this.find(authority, clientMsgId);
    if (!found) return;
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch (error) {
        this.fail(authority, clientMsgId, reliableStorageError(error));
        return;
      }
    }
    const next = pending.filter(
      (entry) =>
        !ownsPending(entry, authority) || entry.clientMsgId !== clientMsgId,
    );
    if (next.length !== pending.length) emitPending(next);
    inFlightPending.delete(pendingKey(authority, clientMsgId));
  },
  /** Persists a storage-denied row if needed, then re-arms exact retry. */
  prepareRetry(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): PendingPrompt | null {
    const found = this.find(authority, clientMsgId);
    if (!found) return null;
    const candidate = {
      ...found,
      error: null,
      retryOnNextActivation: false,
    };
    try {
      const durable = found.durable
        ? cloudConversationOutbox.update(candidate)
        : cloudConversationOutbox.enqueue(candidate);
      if (!durable) return null;
      emitPending(
        pending.map((entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
            ? durable
            : entry,
        ),
      );
      return durable;
    } catch (error) {
      const failed = { ...found, error: reliableStorageError(error) };
      emitPending(
        pending.map((entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
            ? failed
            : entry,
        ),
      );
      return null;
    }
  },
  /** Removes persistence only after a matching canonical turn admission. */
  acknowledgeAdmission(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    conversationId: string,
    turnId: string,
  ): boolean {
    const found = this.find(authority, clientMsgId);
    if (
      !found ||
      !turnId ||
      found.turnId !== turnId ||
      found.conversationId !== conversationId ||
      (found.submission.requestedConversationId !== null &&
        found.submission.requestedConversationId !== conversationId)
    ) {
      return false;
    }
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch {
        return false;
      }
    }
    const acknowledged = {
      ...found,
      durable: false,
      deliveryAcknowledged: true,
      retryOnNextActivation: false,
    };
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? acknowledged
          : entry,
      ),
    );
    return true;
  },
  /** Placement terminal evidence can acknowledge even before a turn id exists. */
  acknowledgeTerminal(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    dispatchId: string,
  ): boolean {
    const found = this.find(authority, clientMsgId);
    if (!found || !dispatchId || found.dispatchId !== dispatchId) return false;
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch {
        return false;
      }
    }
    const acknowledged = {
      ...found,
      durable: false,
      deliveryAcknowledged: true,
      retryOnNextActivation: false,
    };
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? acknowledged
          : entry,
      ),
    );
    return true;
  },
  /** Retires any echo the given canonical record supersedes. */
  resolve(
    authority: CloudConversationOutboxAuthority,
    record: JournalRecord,
  ): void {
    if (!pending.length) return;
    const clientMsgId =
      record.kind === "message" ? record.clientMsgId : undefined;
    const acknowledged = pending.filter(
      (entry) =>
        ownsPending(entry, authority) &&
        ((clientMsgId !== undefined && entry.clientMsgId === clientMsgId) ||
          (clientMsgId !== undefined && entry.dispatchId === clientMsgId) ||
          (entry.turnId !== null && entry.turnId === record.turnId)),
    );
    if (!acknowledged.length) return;
    const removed = new Set<string>();
    for (const entry of acknowledged) {
      try {
        if (!entry.durable || cloudConversationOutbox.remove(entry)) {
          removed.add(entry.clientMsgId);
          inFlightPending.delete(pendingKey(authority, entry.clientMsgId));
        }
      } catch {
        // Keep the durable row. Exact backend dedupe makes a later replay safe,
        // while deleting it only in memory could lose the required retry.
      }
    }
    const next = pending.filter(
      (entry) =>
        !ownsPending(entry, authority) || !removed.has(entry.clientMsgId),
    );
    if (next.length !== pending.length) emitPending(next);
  },
  getServerSnapshot(): readonly PendingPrompt[] {
    return EMPTY_PENDING;
  },
  retainAccountScope(accountScope: string): void {
    activePendingAuthorityKey = null;
    activePendingAuthorityReady = false;
    inFlightPending.clear();
    try {
      cloudConversationOutbox.purgeOtherAccounts(accountScope);
    } catch {
      // Generation activation retries the synchronous purge before any send.
    }
    const next = pending.filter((entry) => entry.accountScope === accountScope);
    if (next.length !== pending.length) emitPending(next);
  },
  activateAuthority(authority: CloudConversationOutboxAuthority): boolean {
    const nextAuthorityKey = authorityKey(authority);
    if (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === nextAuthorityKey
    ) {
      return true;
    }
    activePendingAuthorityKey = nextAuthorityKey;
    activePendingAuthorityReady = false;
    inFlightPending.clear();
    try {
      const hydrated = cloudConversationOutbox
        .activate(authority)
        .map((entry) => {
          if (!entry.retryOnNextActivation) return entry;
          const rearmed = {
            ...entry,
            error: null,
            retryOnNextActivation: false,
          };
          return cloudConversationOutbox.update(rearmed) ?? entry;
        });
      activePendingAuthorityReady = true;
      emitPending(hydrated);
      return true;
    } catch {
      emitPending(EMPTY_PENDING);
      return false;
    }
  },
  isAuthorityReady(authority: CloudConversationOutboxAuthority): boolean {
    return (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === authorityKey(authority)
    );
  },
  claimDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): boolean {
    const entry = this.find(authority, clientMsgId);
    const key = pendingKey(authority, clientMsgId);
    if (
      !entry?.durable ||
      entry.error !== null ||
      !this.isAuthorityReady(authority) ||
      inFlightPending.has(key)
    ) {
      return false;
    }
    inFlightPending.add(key);
    return true;
  },
  releaseDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): void {
    inFlightPending.delete(pendingKey(authority, clientMsgId));
  },
  patch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    update: (entry: PendingPrompt) => PendingPrompt,
  ): void {
    const found = this.find(authority, clientMsgId);
    if (!found) return;
    let nextEntry = update(found);
    if (found.durable) {
      try {
        const persisted = cloudConversationOutbox.update(nextEntry);
        if (!persisted) return;
        nextEntry = persisted;
      } catch (error) {
        nextEntry = { ...nextEntry, error: reliableStorageError(error) };
      }
    }
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? nextEntry
          : entry,
      ),
    );
  },
};
