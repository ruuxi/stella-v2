/** Reuse only records with the same immutable identity as the last successful
 * cache write. Any replaced content remains in the validated wire payload. */
export function cloudCacheDelta<T extends { seq: number }>(
  previous: readonly T[],
  records: readonly T[],
): {
  records: readonly T[];
  retainedRange?: { fromSeq: number; toSeq: number };
} {
  const priorBySeq = new Map(previous.map((record) => [record.seq, record]));
  let start = 0;
  let bestStart = 0;
  let bestLength = 0;
  for (let index = 0; index <= records.length; index += 1) {
    const record = records[index];
    if (!record || priorBySeq.get(record.seq) !== record) {
      const length = index - start;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = index + 1;
    }
  }
  if (bestLength === 0) return { records };
  return {
    records: [
      ...records.slice(0, bestStart),
      ...records.slice(bestStart + bestLength),
    ],
    retainedRange: {
      fromSeq: records[bestStart]!.seq,
      toSeq: records[bestStart + bestLength - 1]!.seq,
    },
  };
}
