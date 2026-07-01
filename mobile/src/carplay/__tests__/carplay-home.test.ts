import { describe, expect, test } from "bun:test";
import {
  buildHome,
  buildTalkRow,
  flattenActions,
  previewText,
  type CarPlayHomeState,
} from "../carplay-home";

const base: CarPlayHomeState = {
  phase: "idle",
  speakingPreview: "",
  replies: [],
};

describe("talk row (tap to talk / tap to stop)", () => {
  test("idle invites a tap to speak", () => {
    const row = buildTalkRow(base);
    expect(row.action).toEqual({ kind: "talk" });
    expect(row.item.text).toBe("Talk to Stella");
    expect(row.item.detailText).toContain("Tap to speak");
    expect(row.item.isPlaying).toBe(false);
  });

  test("listening tells the driver a second tap stops and sends", () => {
    const row = buildTalkRow({ ...base, phase: "listening" });
    expect(row.item.text).toBe("Listening…");
    expect(row.item.detailText).toBe("Tap to stop and send");
    expect(row.item.isPlaying).toBe(true);
  });

  test("speaking shows the reply preview and offers barge-in", () => {
    const row = buildTalkRow({
      ...base,
      phase: "speaking",
      speakingPreview: "It's 72 and sunny in Palo Alto today.",
    });
    expect(row.item.detailText).toBe("It's 72 and sunny in Palo Alto today.");
  });
});

describe("previewText", () => {
  test("collapses whitespace", () => {
    expect(previewText("a\n  b\t c")).toBe("a b c");
  });

  test("clamps long text with an ellipsis", () => {
    const out = previewText("x".repeat(300), 50);
    expect(out.length <= 50).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("recent reply rows", () => {
  const replies = [
    { id: "m2", text: "Newest reply about the weather.", at: 2000 },
    { id: "m1", text: "Older reply about dinner plans.", at: 1000 },
  ];

  test("no replies → no Recent replies section", () => {
    const sections = buildHome(base);
    expect(sections.length).toBe(1);
  });

  test("renders newest + previous reply as tappable read actions", () => {
    const sections = buildHome({ ...base, replies });
    expect(sections[1].header).toBe("Recent replies");
    expect(sections[1].rows.length).toBe(2);
    expect(sections[1].rows[0].item.text).toContain("Newest reply");
    expect(sections[1].rows[0].action).toEqual({
      kind: "readReply",
      id: "m2",
    });
    expect(sections[1].rows[1].action).toEqual({
      kind: "readReply",
      id: "m1",
    });
  });

  test("caps at two rows even if given more", () => {
    const sections = buildHome({
      ...base,
      replies: [...replies, { id: "m0", text: "Ancient.", at: 1 }],
    });
    expect(sections[1].rows.length).toBe(2);
  });
});

describe("buildHome / flattenActions", () => {
  test("flat action order matches rendered row order", () => {
    const sections = buildHome(base);
    const actions = flattenActions(sections);
    expect(actions.length).toBe(
      sections.reduce((n, s) => n + s.rows.length, 0),
    );
    expect(actions[0]).toEqual({ kind: "talk" });
  });
});
