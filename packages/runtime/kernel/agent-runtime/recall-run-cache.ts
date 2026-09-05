import { parseRecallReference, recallLimit } from "@stella/contracts/recall";
export type RecallLookupStatus =
  | "found"
  | "no_match"
  | "retrieval_error"
  | "synthesis_error";

export type RecallLookupResult = {
  status: RecallLookupStatus;
  brief: string;
  /** True when this normalized lookup already ran (or was already in flight). */
  cached?: true;
  intent?: string;
  fastPath?: boolean;
  sources?: Array<{
    kind: "memory" | "thread" | "transcript" | "live";
    summaryId?: number;
    threadId?: string;
    runId?: string;
  }>;
};

const normalizeLookupPart = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");

export const buildRecallLookupCacheKey = (
  prompt: string,
  memorySearchTerms: readonly string[] | undefined,
  limit?: number,
): string => {
  const terms = [
    ...new Set(
      (memorySearchTerms ?? []).map((term) =>
        parseRecallReference(term) ? term.trim() : normalizeLookupPart(term),
      ),
    ),
  ]
    .filter(Boolean)
    .sort();
  return JSON.stringify([
    normalizeLookupPart(prompt),
    terms,
    recallLimit(limit),
  ]);
};

const isRecallLookupError = (result: RecallLookupResult): boolean =>
  result.status === "retrieval_error" || result.status === "synthesis_error";

/**
 * Per-run Recall memoization. Promise values collapse concurrent duplicates;
 * bounded run retention prevents abandoned run ids from growing forever.
 * Failed lookups are shared while in flight, then evicted so a later attempt
 * can recover instead of turning a transient failure into a durable miss.
 */
export class RecallRunCache {
  readonly #runs = new Map<string, Map<string, Promise<RecallLookupResult>>>();

  constructor(private readonly maxRuns = 64) {}

  async getOrCreate(
    runId: string,
    prompt: string,
    memorySearchTerms: readonly string[] | undefined,
    create: () => Promise<RecallLookupResult>,
    limit?: number,
  ): Promise<RecallLookupResult> {
    let entries = this.#runs.get(runId);
    if (!entries) {
      entries = new Map();
      this.#runs.set(runId, entries);
      while (this.#runs.size > this.maxRuns) {
        const oldestRunId = this.#runs.keys().next().value as
          | string
          | undefined;
        if (!oldestRunId) break;
        this.#runs.delete(oldestRunId);
      }
    }
    const key = buildRecallLookupCacheKey(prompt, memorySearchTerms, limit);
    const existing = entries.get(key);
    if (existing) {
      return { ...(await existing), cached: true };
    }
    const pending = Promise.resolve().then(create);
    entries.set(key, pending);
    try {
      const result = await pending;
      if (isRecallLookupError(result) && entries.get(key) === pending) {
        entries.delete(key);
      }
      return result;
    } catch (error) {
      if (entries.get(key) === pending) entries.delete(key);
      throw error;
    }
  }
}
