export type TranscriptSnapshotRow = {
  id: string;
  orderKey: number;
  messageJson: string;
};

/** Diff a complete canonical window while retaining its existing order origin. */
export function diffTranscriptSnapshot(
  existing: readonly TranscriptSnapshotRow[],
  incoming: readonly Omit<TranscriptSnapshotRow, "orderKey">[],
) {
  const prior = new Map(existing.map((row) => [row.id, row]));
  const stride = 1_000_000;
  const anchor = incoming.findIndex((row) => prior.has(row.id));
  // Evicting a prefix or loading an older page must not renumber every row.
  const origin =
    anchor < 0
      ? 0
      : prior.get(incoming[anchor]!.id)!.orderKey - anchor * stride;
  const changed: TranscriptSnapshotRow[] = [];
  const ids = new Set<string>();
  incoming.forEach((row, index) => {
    if (ids.has(row.id))
      throw new Error("Duplicate canonical snapshot message");
    ids.add(row.id);
    const orderKey = origin + index * stride;
    const old = prior.get(row.id);
    if (old?.messageJson !== row.messageJson || old.orderKey !== orderKey) {
      changed.push({ ...row, orderKey });
    }
  });
  return { changed, removed: existing.filter((row) => !ids.has(row.id)) };
}
