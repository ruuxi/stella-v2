/**
 * Structural-sharing helpers for the chat pipeline.
 *
 * The chat surface re-runs its IPC subscriptions whenever SQLite
 * updates. Each fetch hands back a fresh `MessageRecord[]` of fresh
 * objects, which would invalidate every downstream `useMemo` that
 * depends on the array — derived display state, per-row view models,
 * the row components themselves. With long chats that's O(N) work per
 * stream chunk and forces React to walk the full list on every
 * keystroke worth of streamed text.
 *
 * `stabilizeMessageList` and `stabilizeTurnRows` are the t3code-style
 * fix: keep a `byId` map across renders, reuse the prior reference for
 * any entry whose content hasn't changed, and reuse the entire result
 * array when nothing changed at all. Downstream `useMemo` chains then
 * bail out cheaply, and each row component's `memo(..., areEqual)`
 * short-circuits on the `prev.row === next.row` reference check rather
 * than running a deep compare per row.
 */
import type {
  EventRecord,
  MessageRecord,
} from "@stella/contracts/local-chat";

export type StableTurnRowsState<T extends { id: string }> = {
  byId: Map<string, T>;
  result: T[];
};

/**
 * Returns a stable `T[]` (typically `EventRowViewModel[]`) derived from
 * `current`, reusing prior references for entries whose content is
 * shallow-equal under `isEqual`. Mirrors t3code's
 * `computeStableMessagesTimelineRows`.
 *
 * `isEqual` is called per-row only when the incoming reference differs
 * from the previously stored one; supply a fast field-wise comparison
 * (the chat pipeline uses `eventRowEqual` from `lib/row-equality`).
 */
export const stabilizeTurnRows = <T extends { id: string }>(
  current: T[],
  previous: StableTurnRowsState<T> | null,
  isEqual: (a: T, b: T) => boolean,
): StableTurnRowsState<T> => {
  const nextById = new Map<string, T>();
  const nextResult: T[] = new Array(current.length);
  let anyChanged =
    previous === null || current.length !== previous.result.length;

  for (let i = 0; i < current.length; i += 1) {
    const incoming = current[i];
    const prior = previous?.byId.get(incoming.id);
    const stable = prior && isEqual(prior, incoming) ? prior : incoming;
    nextById.set(incoming.id, stable);
    nextResult[i] = stable;
    if (!anyChanged && previous && previous.result[i] !== stable) {
      anyChanged = true;
    }
  }

  if (!anyChanged && previous) {
    return previous;
  }

  return { byId: nextById, result: nextResult };
};

export type StableMessageListState = {
  byId: Map<string, MessageRecord>;
  result: MessageRecord[];
};

const jsonSignatures = new WeakMap<object, string>();

const jsonSignature = (value: unknown): string => {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const cached = jsonSignatures.get(value);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify(value);
  jsonSignatures.set(value, signature);
  return signature;
};

const sameToolEvent = (a: EventRecord, b: EventRecord): boolean =>
  a._id === b._id &&
  a.timestamp === b.timestamp &&
  a.sequence === b.sequence &&
  a.type === b.type &&
  a.deviceId === b.deviceId &&
  a.requestId === b.requestId &&
  a.targetDeviceId === b.targetDeviceId &&
  jsonSignature(a.payload) === jsonSignature(b.payload) &&
  jsonSignature(a.channelEnvelope) === jsonSignature(b.channelEnvelope);

const sameToolEvents = (
  a: EventRecord[] | undefined,
  b: EventRecord[] | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameToolEvent(a[i]!, b[i]!)) return false;
  }
  return true;
};

const sameToolEventSummary = (
  a: MessageRecord["toolEventSummary"],
  b: MessageRecord["toolEventSummary"],
): boolean =>
  a === b ||
  ((a?.totalCount ?? 0) === (b?.totalCount ?? 0) &&
    (a?.loadedCount ?? 0) === (b?.loadedCount ?? 0) &&
    Boolean(a?.truncated) === Boolean(b?.truncated) &&
    Boolean(a?.totalCountIsLowerBound) ===
      Boolean(b?.totalCountIsLowerBound) &&
    Boolean(a?.detailLoaded) === Boolean(b?.detailLoaded) &&
    Boolean(a?.detailHasMore) === Boolean(b?.detailHasMore) &&
    Boolean(a?.livePinsPending) === Boolean(b?.livePinsPending) &&
    (a?.detailCursor?.timestamp ?? null) ===
      (b?.detailCursor?.timestamp ?? null) &&
    (a?.detailCursor?.id ?? null) === (b?.detailCursor?.id ?? null) &&
    (a?.detailCursor?.sequence ?? null) ===
      (b?.detailCursor?.sequence ?? null));

/**
 * Structural-sharing for `MessageRecord[]` (the messages-stream shape).
 * Reuses prior message refs when `_id`, `timestamp`, `payload` ref, and
 * `toolEvents` id sequence all match. The IPC layer returns fresh objects
 * on every refresh, so without this every `useMemo` downstream would
 * invalidate per stream tick — same problem `stabilizeEventList` solves
 * for the legacy raw-event stream.
 */
export const stabilizeMessageList = (
  current: MessageRecord[],
  previous: StableMessageListState | null,
): StableMessageListState => {
  const nextById = new Map<string, MessageRecord>();
  const nextResult: MessageRecord[] = new Array(current.length);
  let anyChanged =
    previous === null || current.length !== previous.result.length;

  for (let i = 0; i < current.length; i += 1) {
    const incoming = current[i]!;
    const prior = previous?.byId.get(incoming._id);
    const sameShape =
      prior !== undefined &&
      prior.timestamp === incoming.timestamp &&
      prior.type === incoming.type &&
      prior.payload === incoming.payload &&
      sameToolEvents(prior.toolEvents, incoming.toolEvents) &&
      sameToolEventSummary(
        prior.toolEventSummary,
        incoming.toolEventSummary,
      );
    const stable = sameShape ? prior! : incoming;
    nextById.set(incoming._id, stable);
    nextResult[i] = stable;
    if (!anyChanged && previous && previous.result[i] !== stable) {
      anyChanged = true;
    }
  }

  if (!anyChanged && previous) {
    return previous;
  }

  return { byId: nextById, result: nextResult };
};

