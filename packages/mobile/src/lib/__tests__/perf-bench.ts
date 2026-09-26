/**
 * Timing harness for the transcript hot paths (not a test). Run from
 * `packages/mobile/` with `bun src/lib/__tests__/perf-bench.ts`. Bun's JIT is
 * far faster than Hermes, so read the numbers as relative costs; the
 * deterministic ratchets live in the neighbouring `*.test.ts` files.
 */
import { syntheticJournal } from "./fixtures/synthetic-journal";
import {
  activeCloudTurnId,
  canonicalCloudDispatchIds,
  mergeCanonicalCloudMessages,
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "../cloud-journal-projection";
import { mobileReplyContexts } from "../mobile-reply-context";
import { encodeCloudJournalTail } from "../cloud-conversation-cache";
import { reuseEqualChatMessages } from "../structural-sharing";
import type { JournalRecord } from "../cloud-conversation-protocol";

const time = (label: string, runs: number, fn: () => unknown) => {
  for (let i = 0; i < 3; i += 1) fn();
  const start = performance.now();
  for (let i = 0; i < runs; i += 1) fn();
  console.log(`${label.padEnd(52)} ${((performance.now() - start) / runs).toFixed(3)} ms`);
};

const pipeline = (records: readonly JournalRecord[]) =>
  mergeCanonicalCloudMessages({
    canonical: rebindCanonicalCloudMessages(
      projectCloudConversationMessages({ conversationId: "c", records }),
      new Map(),
    ),
    local: [],
    dispatchBindings: new Map(),
    acknowledgedDispatchIds: canonicalCloudDispatchIds(records),
  });

for (const turns of [100, 400]) {
  const records = syntheticJournal(turns);
  const before = pipeline(records.slice(0, -1));
  const after = pipeline(records);
  console.log(`\n== ${turns} turns, ${records.length} records, ${after.length} rows ==`);
  time("project + rebind + merge (per committed record)", 50, () => pipeline(records));
  time("reuseEqualChatMessages", 50, () => reuseEqualChatMessages(before, after));
  time("mobileReplyContexts", 50, () => mobileReplyContexts(after));
  time("activeCloudTurnId", 200, () => activeCloudTurnId(records, null));
  time("cache rebuild: stringify every row", 20, () => after.map((row) => JSON.stringify(row)));
  time("cache rebuild: encodeCloudJournalTail", 20, () => encodeCloudJournalTail(records, records.at(-1)!.seq));
  const previous = new Map(before.map((row) => [row.id, row]));
  const churn = (rows: typeof after) => rows.filter((row) => previous.get(row.id) !== row).length;
  console.log(`rows with a new identity after one record: ${churn(after)} raw, ${churn(reuseEqualChatMessages(before, after))} shared`);
}
