import { useEffect, useMemo, useState } from "react";
import type { DesktopThreadActivityRecord as ThreadActivityRecord } from "@/features/chat/thread-activity-types";
import { subscribeToThreadActivityRecord } from "@/features/chat/services/thread-activity-store";

/** Indexed activity rows for a small owned set of threads. Unlike the
 * conversation hook, unrelated agent transitions do not wake this caller. */
export const useThreadActivityRecords = (
  conversationId: string | undefined,
  threadIds: readonly string[],
): ReadonlyMap<string, ThreadActivityRecord> => {
  const threadIdsKey = threadIds.join("\u0000");
  const stableThreadIds = useMemo(
    () => (threadIdsKey ? threadIdsKey.split("\u0000") : []),
    [threadIdsKey],
  );
  const [records, setRecords] = useState<Map<string, ThreadActivityRecord>>(
    () => new Map(),
  );

  useEffect(() => {
    setRecords(new Map());
    if (!conversationId || stableThreadIds.length === 0) return;
    const unsubscribes = stableThreadIds.map((threadId) =>
      subscribeToThreadActivityRecord(conversationId, threadId, (record) => {
        setRecords((current) => {
          const existing = current.get(threadId);
          if (existing === record || (!existing && !record)) return current;
          const next = new Map(current);
          if (record) next.set(threadId, record);
          else next.delete(threadId);
          return next;
        });
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [conversationId, stableThreadIds]);

  return records;
};
