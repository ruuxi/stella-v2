import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import {
  collapseLinkedDuplicates,
  linkOptimisticTurnToCanonical,
  mergeMessagesById,
  reconcileSentDesktopTurn,
} from "../chat-merge";

const user = (id: string, text: string, extra?: Partial<ChatMessage>): ChatMessage => ({
  id,
  role: "user",
  text,
  ...extra,
});

const assistant = (
  id: string,
  text: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({
  id,
  role: "assistant",
  text,
  ...extra,
});

const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

describe("mergeMessagesById", () => {
  test("matches by canonicalId and keeps the local id and timestamp", () => {
    const current = [
      user("local-1", "hi", { canonicalId: "desk-1", createdAt: 100 }),
    ];
    const incoming = [user("desk-1", "hi", { createdAt: 90 })];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-1"]);
    expect(merged[0]?.createdAt).toBe(100);
    expect(merged[0]?.canonicalId).toBe("desk-1");
  });

  test("does not duplicate when the canonical row is re-delivered (task anchors)", () => {
    const current = [
      user("local-1", "run the task", { canonicalId: "desk-1", createdAt: 100 }),
      assistant("local-2", "on it", { canonicalId: "desk-2", createdAt: 101 }),
    ];
    const incoming = [
      user("desk-1", "run the task", { createdAt: 95 }),
      assistant("desk-2", "on it", { createdAt: 96 }),
    ];
    expect(ids(mergeMessagesById(current, incoming))).toEqual([
      "local-1",
      "local-2",
    ]);
  });

  test("collapses an unlinked canonical twin into the linked local row", () => {
    // A mid-turn sync merged desk-1 as its own row before the reconcile linked
    // the optimistic bubble; the next delivery of desk-1 heals the duplicate.
    const current = [
      user("local-1", "hello", { canonicalId: "desk-1", createdAt: 100 }),
      user("desk-1", "hello", { createdAt: 95 }),
    ];
    const incoming = [user("desk-1", "hello", { createdAt: 95 })];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-1"]);
    expect(merged[0]?.createdAt).toBe(100);
  });

  test("links a late-arriving canonical reply by requestId instead of duplicating", () => {
    const current = [
      user("local-u", "question", { canonicalId: "desk-u", createdAt: 100 }),
      assistant("local-a", "answer", { requestId: "desk-u", createdAt: 101 }),
    ];
    const incoming = [
      assistant("desk-a", "answer", { requestId: "desk-u", createdAt: 96 }),
    ];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-u", "local-a"]);
    expect(merged[1]?.canonicalId).toBe("desk-a");
    expect(merged[1]?.createdAt).toBe(101);
  });

  test("never links stand-in artifact rows by requestId", () => {
    const current = [
      assistant("local-a", "answer", { requestId: "desk-u", createdAt: 101 }),
    ];
    const incoming = [
      assistant("desk-u:agent", "", {
        requestId: "desk-u",
        createdAt: 90,
        artifacts: [],
      }),
    ];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toContain("local-a");
    expect(ids(merged)).toContain("desk-u:agent");
    expect(merged.find((m) => m.id === "local-a")?.text).toBe("answer");
  });

  test("does not link user rows by text (repeat messages stay distinct)", () => {
    const current = [user("local-1", "ok", { createdAt: 100 })];
    const incoming = [user("desk-9", "ok", { createdAt: 50 })];
    expect(mergeMessagesById(current, incoming)).toHaveLength(2);
  });

  test("slots a synced row between its canonical neighbours", () => {
    // History previously merged off the bridge — rows carry canonical stamps.
    const current = mergeMessagesById(
      [],
      [
        user("a", "first", { createdAt: 100 }),
        assistant("b", "second", { createdAt: 200 }),
      ],
    );
    const incoming = [assistant("c", "between", { createdAt: 150 })];
    expect(ids(mergeMessagesById(current, incoming))).toEqual(["a", "c", "b"]);
  });
});

describe("canonical ordering across clock skew (older desktop row filed below newer exchange)", () => {
  // Regression: the desktop clock ran ahead of the phone's. A deferred pull
  // delivered an OLDER desktop reply ("that's the full cycle done, 5 reviews,
  // 7 fix agents…") after the user's next phone-sent exchange ("review loop"
  // → "round 2 dispatched…") had already streamed and reconciled with
  // phone-clock anchors. Comparing the desktop stamp against those anchors
  // filed the older reply at the tail — below the newer exchange. Ordering
  // now runs on `canonicalCreatedAt` (the desktop's own clock, which its
  // cursor orders by), so the transcript converges to the desktop's sequence.
  test("a deferred pull's older desktop reply slots above the newer phone-sent exchange", () => {
    // Already-synced canonical history (desktop clock ~90s ahead).
    let transcript = mergeMessagesById(
      [],
      [
        user("desk-u1", "kick off the review loop", { createdAt: 1_000_000 }),
        assistant("desk-a1", "starting the loop", { createdAt: 1_001_000 }),
      ],
    );
    // Phone sends the next turn; optimistic rows anchor to the phone clock —
    // numerically BEHIND every desktop stamp above.
    transcript = [
      ...transcript,
      user("local-u", "start round 2 of the review loop", {
        createdAt: 911_000,
      }),
      assistant("local-a", "round 2 dispatched", { createdAt: 911_500 }),
    ];
    // Turn ends; the reconcile links the optimistic rows to canonical ids.
    transcript = reconcileSentDesktopTurn({
      current: transcript,
      userMessageId: "local-u",
      replyId: "local-a",
      sentText: "start round 2 of the review loop",
      canonicalMessages: [
        user("desk-u2", "start round 2 of the review loop", {
          createdAt: 1_003_000,
        }),
        assistant("desk-a2", "round 2 dispatched", {
          requestId: "desk-u2",
          createdAt: 1_004_000,
        }),
      ],
      canonicalUserMessageId: "desk-u2",
    });
    expect(ids(transcript)).toEqual([
      "desk-u1",
      "desk-a1",
      "local-u",
      "local-a",
    ]);
    // A later (e.g. mid-send-deferred) pull finally delivers the OLDER
    // desktop reply the phone had never seen. Canonically it precedes the
    // new exchange; its desktop stamp is numerically LARGER than the
    // phone-clock anchors, which used to file it at the tail.
    const merged = mergeMessagesById(transcript, [
      assistant(
        "desk-a1b",
        "that's the full cycle done, 5 reviews, 7 fix agents",
        { createdAt: 1_002_000 },
      ),
    ]);
    expect(ids(merged)).toEqual([
      "desk-u1",
      "desk-a1",
      "desk-a1b",
      "local-u",
      "local-a",
    ]);
    // Display anchors survive; only the ordering key is canonical.
    const localU = merged.find((m) => m.id === "local-u");
    expect(localU?.createdAt).toBe(911_000);
    expect(localU?.canonicalCreatedAt).toBe(1_003_000);
  });

  test("rows without canonical identity stay glued to their neighbours", () => {
    // A local-only turn (e.g. an offline error exchange that will never gain
    // canonical ids) must never be split or re-filed by cross-clock
    // comparison when canonical rows merge around it: it stays attached
    // behind its predecessor, in its own relative order, regardless of how
    // its phone-clock anchors compare to the desktop stamps.
    const transcript = mergeMessagesById(
      [
        ...mergeMessagesById(
          [],
          [user("desk-u1", "old history", { createdAt: 1_000_000 })],
        ),
        user("local-u", "wake my computer", { createdAt: 911_000 }),
        assistant("local-a", "Your computer is offline.", {
          createdAt: 911_100,
        }),
      ],
      [assistant("desk-a9", "a genuinely new reply", { createdAt: 1_005_000 })],
    );
    expect(ids(transcript)).toEqual([
      "desk-u1",
      "local-u",
      "local-a",
      "desk-a9",
    ]);
  });

  test("a linked-by-requestId reply cannot invert above its unstamped user row", () => {
    // Phone clock AHEAD of the desktop's this time: the user bubble's local
    // anchor (100) is numerically larger than the canonical reply stamp (96).
    const merged = mergeMessagesById(
      [
        user("local-u", "question", { canonicalId: "desk-u", createdAt: 100 }),
        assistant("local-a", "answer", { requestId: "desk-u", createdAt: 101 }),
      ],
      [assistant("desk-a", "answer", { requestId: "desk-u", createdAt: 96 })],
    );
    expect(ids(merged)).toEqual(["local-u", "local-a"]);
  });

  test("same-stamp canonical rows delivered in reverse converge to id order", () => {
    // Two desktop rows share a millisecond stamp; the later delta happens to
    // deliver the id-lower one second. The desktop cursor orders by
    // (timestamp, id), so the transcript must converge to id order —
    // delivery order alone would diverge from the desktop.
    const current = mergeMessagesById(
      [],
      [assistant("desk-b", "second by id", { createdAt: 1_000_000 })],
    );
    const merged = mergeMessagesById(current, [
      assistant("desk-a", "first by id", { createdAt: 1_000_000 }),
    ]);
    expect(ids(merged)).toEqual(["desk-a", "desk-b"]);
  });

  test("a linked row ties by its canonical id, not its local id", () => {
    // The linked bubble's LOCAL id ("zzz-local") would sort after "desk-m";
    // its canonical identity ("desk-a") sorts before. The canonical id must
    // drive the tie so linked and direct rows converge identically.
    const merged = mergeMessagesById(
      [
        {
          ...user("zzz-local", "question", {
            canonicalId: "desk-a",
            createdAt: 911_000,
          }),
          canonicalCreatedAt: 1_000_000,
        },
      ],
      [assistant("desk-m", "same-stamp row", { createdAt: 1_000_000 })],
    );
    expect(ids(merged)).toEqual(["zzz-local", "desk-m"]);
  });

  test("the healed twin donates its canonical stamp to the linked survivor", () => {
    // The linked bubble was stamped only locally (stream-end link); the twin
    // IS the canonical row — its desktop stamp must survive the collapse so
    // later merges order the turn canonically.
    const healed = collapseLinkedDuplicates([
      user("local-u", "hello", { canonicalId: "desk-u", createdAt: 100 }),
      user("desk-u", "hello", { createdAt: 1_002_000 }),
    ]);
    expect(ids(healed)).toEqual(["local-u"]);
    expect(healed[0]?.canonicalCreatedAt).toBe(1_002_000);
    expect(healed[0]?.createdAt).toBe(100);
  });
});

describe("mid-send foreground sync duplicate (user row rendered twice)", () => {
  // Regression: a foreground/refocus/Force-Sync pull that fired MID-SEND
  // merged the turn's canonical user row before the optimistic bubble was
  // linked. The twin sorted onto the (skewed-ahead) desktop clock, below the
  // streaming reply, and — because that pull advanced the cursor past the
  // turn — the post-turn reconcile's delta never re-delivered it, so nothing
  // healed the duplicate and it persisted to storage.
  test("merge heals the twin even when the canonical row is never re-delivered", () => {
    // Optimistic turn, anchored to the phone clock.
    let transcript: ChatMessage[] = [
      user("local-u", "By the way, for the redesign…", { createdAt: 100 }),
      assistant("local-a", "", { createdAt: 101 }),
    ];
    // Mid-send pull: canonical user row, desktop clock slightly ahead. No
    // link exists yet (text matching is deliberately excluded), so it lands
    // as its own row BELOW the reply — the bug's visible symptom.
    transcript = mergeMessagesById(transcript, [
      user("desk-u", "By the way, for the redesign…", { createdAt: 105 }),
    ]);
    expect(ids(transcript)).toEqual(["local-u", "local-a", "desk-u"]);
    // Stream end: the bridge result links the optimistic rows directly.
    transcript = transcript.map((m) =>
      m.id === "local-u"
        ? { ...m, canonicalId: "desk-u" }
        : m.id === "local-a"
          ? { ...m, text: "Sounds good.", requestId: "desk-u" }
          : m,
    );
    // Post-turn reconcile delta: only the canonical reply — desk-u was
    // already consumed by the mid-send pull. The merge must still collapse
    // the twin into the linked bubble.
    const healed = mergeMessagesById(transcript, [
      assistant("desk-a", "Sounds good.", {
        requestId: "desk-u",
        createdAt: 106,
      }),
    ]);
    expect(ids(healed)).toEqual(["local-u", "local-a"]);
    expect(healed[0]?.canonicalId).toBe("desk-u");
    expect(healed[1]?.canonicalId).toBe("desk-a");
  });

  test("an empty delta still heals a persisted twin", () => {
    const current = [
      user("local-u", "hello", { canonicalId: "desk-u", createdAt: 100 }),
      assistant("local-a", "hi", { createdAt: 101 }),
      user("desk-u", "hello", { createdAt: 105 }),
    ];
    expect(ids(mergeMessagesById(current, []))).toEqual([
      "local-u",
      "local-a",
    ]);
  });
});

describe("collapseLinkedDuplicates", () => {
  test("drops the unlinked twin and keeps the linked row's anchor", () => {
    const healed = collapseLinkedDuplicates([
      user("local-u", "hello", { canonicalId: "desk-u", createdAt: 100 }),
      assistant("local-a", "hi", { createdAt: 101 }),
      user("desk-u", "hello", { createdAt: 105 }),
    ]);
    expect(ids(healed)).toEqual(["local-u", "local-a"]);
    expect(healed[0]?.createdAt).toBe(100);
  });

  test("adopts the twin's artifacts when the linked row has none", () => {
    const artifacts = [
      { id: "art-1", conversationId: "conv-1", payload: {} },
    ] as unknown as ChatMessage["artifacts"];
    const healed = collapseLinkedDuplicates([
      assistant("local-a", "done", { canonicalId: "desk-a", createdAt: 100 }),
      assistant("desk-a", "done", { createdAt: 105, artifacts }),
    ]);
    expect(ids(healed)).toEqual(["local-a"]);
    expect(healed[0]?.artifacts).toEqual(artifacts);
  });

  test("leaves unrelated repeats and unlinked rows alone (same reference)", () => {
    const current = [
      user("a", "ok", { createdAt: 1 }),
      user("b", "ok", { createdAt: 2 }),
      user("c", "later", { canonicalId: "desk-c", createdAt: 3 }),
    ];
    expect(collapseLinkedDuplicates(current)).toBe(current);
  });
});

describe("reconcileSentDesktopTurn", () => {
  const baseTurn = () => ({
    userMessageId: "local-u",
    replyId: "local-a",
    sentText: "do the thing",
    current: [
      user("local-u", "do the thing", { createdAt: 100 }),
      assistant("local-a", "done!", { createdAt: 101 }),
    ],
  });

  test("links optimistic rows to canonical ids and keeps local anchors", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    expect(ids(result)).toEqual(["local-u", "local-a"]);
    expect(result[0]?.canonicalId).toBe("desk-u");
    expect(result[1]?.canonicalId).toBe("desk-a");
    expect(result[0]?.createdAt).toBe(100);
    expect(result[1]?.createdAt).toBe(101);
  });

  test("evicts canonical twins a mid-turn sync already merged", () => {
    const turn = baseTurn();
    const result = reconcileSentDesktopTurn({
      ...turn,
      current: [
        ...turn.current,
        // Duplicates merged mid-turn by the task poll.
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { createdAt: 91 }),
      ],
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    expect(ids(result)).toEqual(["local-u", "local-a"]);
  });

  test("never adopts a stand-in artifact row as the canonical reply", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
        assistant("desk-u:agent", "", {
          requestId: "desk-u",
          createdAt: 92,
          artifacts: [],
        }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    const reply = result.find((m) => m.id === "local-a");
    expect(reply?.canonicalId).toBe("desk-a");
    expect(reply?.text).toBe("done!");
  });

  test("picks the reply by requestId when the delta spans other turns", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
        // A desktop-side turn that finished after ours.
        user("desk-u2", "unrelated", { createdAt: 92 }),
        assistant("desk-a2", "other reply", {
          requestId: "desk-u2",
          createdAt: 93,
        }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    const reply = result.find((m) => m.id === "local-a");
    expect(reply?.canonicalId).toBe("desk-a");
    expect(reply?.text).toBe("done!");
    // The desktop-side turn still merges as its own rows.
    expect(ids(result)).toContain("desk-u2");
    expect(ids(result)).toContain("desk-a2");
  });

  test("falls back to text/last-assistant matching without a canonical id", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { createdAt: 91 }),
      ],
    });
    expect(result.find((m) => m.id === "local-u")?.canonicalId).toBe("desk-u");
    expect(result.find((m) => m.id === "local-a")?.canonicalId).toBe("desk-a");
  });
});

describe("linkOptimisticTurnToCanonical (interrupted/stopped turn)", () => {
  test("links the optimistic user bubble and reply to the canonical ids", () => {
    const current = [
      user("local-u", "message A", { createdAt: 100 }),
      assistant("local-a", "", { createdAt: 101, stopped: true }),
    ];
    const linked = linkOptimisticTurnToCanonical(current, {
      userMessageId: "local-u",
      replyId: "local-a",
      canonicalUserMessageId: "desk-u",
    });
    expect(linked.find((m) => m.id === "local-u")?.canonicalId).toBe("desk-u");
    expect(linked.find((m) => m.id === "local-a")?.requestId).toBe("desk-u");
  });

  test("never clobbers link fields a completed turn already set", () => {
    const current = [
      user("local-u", "message A", { canonicalId: "desk-existing" }),
      assistant("local-a", "answer", { requestId: "desk-existing" }),
    ];
    const linked = linkOptimisticTurnToCanonical(current, {
      userMessageId: "local-u",
      replyId: "local-a",
      canonicalUserMessageId: "desk-u",
    });
    expect(linked).toBe(current);
    expect(linked.find((m) => m.id === "local-u")?.canonicalId).toBe(
      "desk-existing",
    );
  });

  test("is a no-op without a canonical id (bridge never reported one)", () => {
    const current = [user("local-u", "message A", { createdAt: 100 })];
    expect(
      linkOptimisticTurnToCanonical(current, {
        userMessageId: "local-u",
        replyId: "local-a",
        canonicalUserMessageId: "  ",
      }),
    ).toBe(current);
  });

  test("send → stop → send: the first user message stays single after reconcile", () => {
    // Message A was sent; the user stopped the turn mid-stream. Without the
    // stop-path link, the optimistic bubble keeps only its local id, so the
    // next send's wake→sync pulls the canonical user row and mergeMessagesById
    // (id/canonicalId only) appends it as a duplicate of message A.
    const afterStopUnlinked = [
      user("local-u", "message A", { createdAt: 100 }),
      assistant("local-a", "", { createdAt: 101, stopped: true }),
    ];
    const canonicalPull = [
      user("desk-u", "message A", { createdAt: 100 }),
    ];
    // The bug: unlinked bubble + canonical pull duplicates message A.
    expect(
      mergeMessagesById(afterStopUnlinked, canonicalPull).filter(
        (m) => m.role === "user",
      ),
    ).toHaveLength(2);

    // The fix: the stop path links the bubble to its canonical id first, so
    // the same pull folds into the existing bubble — message A stays single.
    const afterStopLinked = linkOptimisticTurnToCanonical(afterStopUnlinked, {
      userMessageId: "local-u",
      replyId: "local-a",
      canonicalUserMessageId: "desk-u",
    });
    const reconciled = mergeMessagesById(afterStopLinked, canonicalPull);
    const usersA = reconciled.filter(
      (m) => m.role === "user" && m.text === "message A",
    );
    expect(usersA).toHaveLength(1);
    expect(usersA[0]?.id).toBe("local-u");
    expect(usersA[0]?.canonicalId).toBe("desk-u");
  });
});
