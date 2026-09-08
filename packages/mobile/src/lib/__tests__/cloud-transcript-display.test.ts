import { describe, expect, test } from "bun:test";
import { planCloudTranscriptDisplay } from "../cloud-transcript-display";
import type { ChatMessage } from "../../types";

const rows = (...ids: string[]): ChatMessage[] =>
  ids.map((id, index) => ({
    id,
    role: index % 2 === 0 ? "user" : "assistant",
    text: id,
  }));

const base = {
  caughtUp: false,
  settledFailure: false,
  cacheVisible: false,
  cached: null,
  projected: [] as ChatMessage[],
  lastShown: null,
  everShown: false,
};

describe("planCloudTranscriptDisplay", () => {
  test("first paint waits for the journal when nothing is cached", () => {
    const plan = planCloudTranscriptDisplay(base);
    expect(plan.shown).toBe(false);
    expect(plan.messages).toEqual([]);
    expect(plan.holding).toBe(false);
  });

  test("cold start paints the disk cache before the socket connects", () => {
    const cached = rows("u1", "a1");
    const plan = planCloudTranscriptDisplay({
      ...base,
      cacheVisible: true,
      cached,
    });
    expect(plan.shown).toBe(true);
    expect(plan.messages).toBe(cached);
  });

  test("the cache stays on screen between `ready` and the replayed rows", () => {
    const cached = rows("u1", "a1");
    // `ready` landed: epoch is known so the cache is no longer authoritative,
    // but no record has been applied yet. This is the moment that used to
    // blank the list on every app open.
    const plan = planCloudTranscriptDisplay({
      ...base,
      cacheVisible: false,
      cached,
      projected: [],
      lastShown: cached,
      everShown: true,
    });
    expect(plan.shown).toBe(true);
    expect(plan.holding).toBe(true);
    expect(plan.messages).toBe(cached);
  });

  test("a reconnect that announces new rows keeps the retained transcript", () => {
    const projected = rows("u1", "a1", "u2");
    // headSeq moved above the last applied seq; the delta is still in flight.
    const plan = planCloudTranscriptDisplay({
      ...base,
      caughtUp: false,
      projected,
      lastShown: projected,
      everShown: true,
    });
    expect(plan.shown).toBe(true);
    expect(plan.holding).toBe(false);
    expect(plan.messages).toBe(projected);
  });

  test("an epoch reset holds the last transcript until the new window lands", () => {
    const previous = rows("u1", "a1");
    const held = planCloudTranscriptDisplay({
      ...base,
      projected: [],
      lastShown: previous,
      everShown: true,
    });
    expect(held.shown).toBe(true);
    expect(held.messages).toBe(previous);

    const replaced = rows("u9", "a9");
    const landed = planCloudTranscriptDisplay({
      ...base,
      caughtUp: true,
      projected: replaced,
      lastShown: previous,
      everShown: true,
    });
    expect(landed.holding).toBe(false);
    expect(landed.messages).toBe(replaced);
  });

  test("a conversation that is genuinely empty once caught up shows empty", () => {
    const plan = planCloudTranscriptDisplay({
      ...base,
      caughtUp: true,
      projected: [],
      lastShown: rows("u1"),
      everShown: true,
    });
    expect(plan.shown).toBe(true);
    expect(plan.holding).toBe(false);
    expect(plan.messages).toEqual([]);
  });

  test("a settled socket failure never stands in stale rows for an empty view", () => {
    const plan = planCloudTranscriptDisplay({
      ...base,
      settledFailure: true,
      projected: [],
      lastShown: rows("u1"),
      everShown: false,
    });
    expect(plan.shown).toBe(true);
    expect(plan.holding).toBe(false);
    expect(plan.messages).toEqual([]);
  });

  test("caught-up projection is returned by identity so memoised rows are stable", () => {
    const projected = rows("u1", "a1");
    const plan = planCloudTranscriptDisplay({
      ...base,
      caughtUp: true,
      projected,
      lastShown: projected,
      everShown: true,
    });
    expect(plan.messages).toBe(projected);
  });
});
