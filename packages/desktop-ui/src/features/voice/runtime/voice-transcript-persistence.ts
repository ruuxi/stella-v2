export type VoiceTranscriptPersistencePayload = {
  conversationId: string;
  eventId: string;
  timestamp: number;
  role: "user" | "assistant";
  text: string;
  uiVisibility?: "visible" | "hidden";
  voiceSession?: { durationMs: number };
};

export type VoiceTranscriptPersistenceOptions = {
  sleep?: (delayMs: number) => Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Test-only bound. Production intentionally retries for the renderer lifetime. */
  maxAttempts?: number;
  onRetry?: (error: unknown, attempt: number) => void;
};

type VoiceTranscriptPersistenceItem = {
  persist: (
    payload: VoiceTranscriptPersistencePayload,
  ) => Promise<{ ok: true }>;
  payload: VoiceTranscriptPersistencePayload;
  options: VoiceTranscriptPersistenceOptions;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const sleepFor = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Invokes the main-process durability boundary until it acknowledges that the
 * SQLite inbox row is committed. The caller creates `eventId` once; every retry
 * reuses the exact payload so main, worker, and cloud dedupe stay valid.
 */
export const persistVoiceTranscriptWithRetry = async (
  persist: (
    payload: VoiceTranscriptPersistencePayload,
  ) => Promise<{ ok: true }>,
  payload: VoiceTranscriptPersistencePayload,
  options: VoiceTranscriptPersistenceOptions = {},
): Promise<{ ok: true }> => {
  const sleep = options.sleep ?? sleepFor;
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 250);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 10_000);
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? Number.MAX_SAFE_INTEGER,
  );
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await persist(payload);
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      options.onRetry?.(error, attempt);
      const delayMs = Math.min(
        retryMaxMs,
        retryBaseMs * 2 ** Math.min(attempt - 1, 8),
      );
      await sleep(delayMs);
    }
  }
};

/**
 * FIFO renderer-side admission queue. Starting a previously idle queue invokes
 * the main-process IPC immediately in the realtime callback's current stack;
 * later events wait behind the first so transcript order remains stable.
 */
export class VoiceTranscriptPersistenceQueue {
  private readonly items: VoiceTranscriptPersistenceItem[] = [];
  private draining = false;

  enqueue(
    persist: VoiceTranscriptPersistenceItem["persist"],
    payload: VoiceTranscriptPersistencePayload,
    options: VoiceTranscriptPersistenceOptions = {},
  ): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.items.push({ persist, payload, options, resolve, reject });
    });
    this.resume();
    return completion;
  }

  private resume(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.items.length > 0) {
        const item = this.items[0]!;
        try {
          await persistVoiceTranscriptWithRetry(
            item.persist,
            item.payload,
            item.options,
          );
          item.resolve();
        } catch (error) {
          item.reject(error);
        } finally {
          this.items.shift();
        }
      }
    } finally {
      this.draining = false;
      // An enqueue can race the final empty check while the drain is resolving.
      if (this.items.length > 0) this.resume();
    }
  }
}
