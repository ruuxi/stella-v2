import { describe, expect, test } from "bun:test";
import {
  mergeRecallExchanges,
  parseRecallReference,
  recallExcerpt,
  recallReference,
  recallRequest,
  recallSearchPlan,
  renderRecallExchanges,
  type RecallMessage,
} from "@stella/contracts/recall";

const message = (
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): RecallMessage => ({
  scope: "conversation",
  id,
  text,
  role,
  atMs: 1000,
  order: Number(id),
});

describe("shared Recall policy", () => {
  test("merges overlapping windows transitively, retaining distinct exchanges and corrections", () => {
    const a = message("1", "Use SQLite", "assistant");
    const b = message("2", "No, keep PostgreSQL.");
    const c = message("3", "Confirmed PostgreSQL", "assistant");
    const d = message("4", "Unrelated earlier project");
    const windows = [
      { matchedIds: [a.id], messages: [a, b] },
      { matchedIds: [c.id], messages: [c] },
      { matchedIds: [b.id], messages: [b, c] },
      { matchedIds: [d.id], messages: [d] },
    ];
    expect(mergeRecallExchanges(windows)).toHaveLength(2);
    const text = renderRecallExchanges(windows, ["SQLite"]);
    expect(text.match(/No, keep PostgreSQL/g)).toHaveLength(1);
    expect(text.indexOf("Use SQLite")).toBeLessThan(text.indexOf("No, keep"));
    expect(text).toContain("1970-01-01T00:00:01.000Z] User");
    expect(text).toContain("Stella (messageRef=recall:conversation:1:0)");
    expect(text).toContain("Unrelated earlier project");
  });

  test("centers deep matches and pages the exact original text", () => {
    const text = "a".repeat(9000) + " NEEDLE " + "b".repeat(5000);
    const excerpt = recallExcerpt(text, ["NEEDLE"]);
    expect(excerpt.text).toContain("NEEDLE");
    expect(excerpt.nextOffset).toBeGreaterThan(9000);
    const next = recallReference("conversation", "1", excerpt.nextOffset!);
    const output = renderRecallExchanges(
      [{ matchedIds: ["1"], messages: [message("1", text)] }],
      [next],
    );
    expect(output).not.toContain("NEEDLE");
    expect(output).toContain("b".repeat(100));
    expect(parseRecallReference(next)?.offset).toBe(excerpt.nextOffset);
  });

  test("escapes FTS operators, preserves phrases, and rejects empty queries", () => {
    const plan = recallSearchPlan(['hello" OR *', "red blue"]);
    expect(plan?.phrase).toBe('"hello"" OR *" OR "red blue"');
    expect(plan?.broad).toContain('"red" OR "blue"');
    expect(recallSearchPlan(["!!!"])).toBeNull();
    expect(() =>
      recallRequest({ prompt: "find", messageRef: "garbage" }),
    ).toThrow();
    const ref = recallReference("conv:a", "MiXeD/id", 1500);
    expect(recallRequest({ prompt: "read", messageRef: ref }).terms).toEqual([
      ref,
    ]);
  });

  test("keeps distinct exchanges within a fixed result budget", () => {
    const windows = Array.from({ length: 30 }, (_, i) => ({
      matchedIds: [String(i)],
      messages: [message(String(i), `Unique-${i} ${"x".repeat(8000)}`)],
    }));
    const output = renderRecallExchanges(windows, ["Unique"]);
    expect(output.length).toBeLessThanOrEqual(12000);
    expect(output.match(/# Exchange /g)!.length).toBeGreaterThan(1);
  });
});
