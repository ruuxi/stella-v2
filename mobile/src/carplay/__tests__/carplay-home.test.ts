import { describe, expect, test } from "bun:test";
import {
  buildHome,
  buildTalkRow,
  flattenActions,
  formatRelativeTime,
  parseTemplateConfig,
  previewText,
  type CarPlayHomeState,
} from "../carplay-home";

const NOW = 1_700_000_000_000;

const base: CarPlayHomeState = {
  phase: "idle",
  speakingPreview: "",
  replies: [],
  newReplyId: null,
  converseOn: true,
  target: "phone",
  targetSelectable: false,
  now: NOW,
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

describe("formatRelativeTime", () => {
  test("under a minute is 'now'", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("now");
  });
  test("minutes", () => {
    expect(formatRelativeTime(NOW - 2 * 60_000, NOW)).toBe("2m ago");
  });
  test("hours", () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });
  test("days", () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });
  test("future/clock-skew clamps to 'now'", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("now");
  });
});

describe("recent reply rows", () => {
  const replies = [
    { id: "m2", text: "Newest reply about the weather.", at: NOW - 2 * 60_000 },
    { id: "m1", text: "Older reply about dinner plans.", at: NOW - 3_600_000 },
  ];

  test("rows carry relative timestamps", () => {
    const sections = buildHome({ ...base, replies });
    expect(sections[1].rows[0].item.detailText).toBe("2m ago");
    expect(sections[1].rows[1].item.detailText).toBe("1h ago");
  });

  test("the new reply is marked with an indicator + timestamp", () => {
    const sections = buildHome({ ...base, replies, newReplyId: "m2" });
    expect(sections[1].rows[0].item.detailText).toBe(
      "New · 2m ago — tap to hear it",
    );
    expect(sections[1].rows[1].item.detailText).toBe("1h ago");
  });

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

describe("read-latest row", () => {
  test("hidden when there are no replies (no dead taps)", () => {
    const sections = buildHome(base);
    expect(
      flattenActions(sections).some((a) => a.kind === "readLatest"),
    ).toBe(false);
  });

  test("previews the newest reply and reads it on tap", () => {
    const sections = buildHome({
      ...base,
      replies: [{ id: "m9", text: "Latest answer here.", at: NOW }],
    });
    const row = sections[0].rows.find(
      (r) => r.action.kind === "readLatest",
    );
    expect(row !== undefined).toBe(true);
    expect(row!.item.text).toBe("Read latest reply");
    expect(row!.item.detailText).toContain("Latest answer here.");
  });
});

describe("converse mode row", () => {
  const converseRow = (state: CarPlayHomeState) =>
    buildHome(state)[0].rows.find((r) => r.action.kind === "toggleConverse")!;

  test("always present with visible On state", () => {
    const row = converseRow(base);
    expect(row.item.text).toBe("Converse mode: On");
    expect(row.item.detailText).toContain("automatically");
  });

  test("visible Off state invites turning it back on", () => {
    const row = converseRow({ ...base, converseOn: false });
    expect(row.item.text).toBe("Converse mode: Off");
    expect(row.item.detailText).toBe("Tap to hear replies automatically");
  });
});

describe("voice target row (phone chat vs computer chat)", () => {
  const targetRow = (state: CarPlayHomeState) =>
    buildHome(state)[0].rows.find((r) => r.action.kind === "toggleTarget");

  test("hidden when no computer is paired (no dead taps)", () => {
    expect(targetRow(base) === undefined).toBe(true);
  });

  test("phone target invites switching to the computer", () => {
    const row = targetRow({ ...base, targetSelectable: true });
    expect(row !== undefined).toBe(true);
    expect(row!.item.text).toBe("Send to: Phone");
    expect(row!.item.detailText).toContain("tap to use your computer");
  });

  test("computer target names the computer chat and offers the phone", () => {
    const row = targetRow({
      ...base,
      target: "computer",
      targetSelectable: true,
    });
    expect(row!.item.text).toBe("Send to: Computer");
    expect(row!.item.detailText).toContain("tap to use this phone");
  });
});

describe("parseTemplateConfig (resolveAssetSource interop shim)", () => {
  const resolveImage = (source: unknown) => ({
    uri: `resolved-${String(source)}`,
    scale: 2,
  });

  test("resolves image-suffixed keys at any depth", () => {
    const out = parseTemplateConfig(
      {
        type: "list",
        sections: [{ items: [{ text: "Talk", image: 42 }] }],
        tabImage: 7,
      },
      resolveImage,
    ) as Record<string, unknown>;
    expect(out.tabImage).toEqual({ uri: "resolved-7", scale: 2 });
    const item = (out.sections as { items: { image: unknown }[] }[])[0]
      .items[0];
    expect(item.image).toEqual({ uri: "resolved-42", scale: 2 });
  });

  test("leaves non-image keys untouched and drops function props", () => {
    const out = parseTemplateConfig(
      {
        title: "Stella",
        onItemSelect: () => undefined,
        sections: [{ items: [{ text: "row", isPlaying: true }] }],
      },
      resolveImage,
    ) as Record<string, unknown>;
    expect(out.title).toBe("Stella");
    expect("onItemSelect" in out).toBe(false);
    expect(
      (out.sections as { items: { isPlaying: boolean }[] }[])[0].items[0]
        .isPlaying,
    ).toBe(true);
  });

  test("skips null/undefined image values", () => {
    const out = parseTemplateConfig(
      { items: [{ text: "no icon", image: undefined }] },
      resolveImage,
    ) as { items: Record<string, unknown>[] };
    expect("image" in out.items[0]).toBe(false);
  });
});

describe("buildHome / flattenActions", () => {
  test("flat action order matches rendered row order", () => {
    const sections = buildHome({
      ...base,
      replies: [
        { id: "m2", text: "Newest.", at: NOW },
        { id: "m1", text: "Older.", at: NOW - 60_000 },
      ],
    });
    const actions = flattenActions(sections);
    expect(actions.length).toBe(
      sections.reduce((n, s) => n + s.rows.length, 0),
    );
    expect(actions.map((a) => a.kind)).toEqual([
      "talk",
      "readLatest",
      "toggleConverse",
      "readReply",
      "readReply",
    ]);
  });

  test("paired state adds the target row after converse mode", () => {
    const sections = buildHome({
      ...base,
      targetSelectable: true,
      target: "computer",
      replies: [{ id: "m2", text: "Newest.", at: NOW }],
    });
    expect(flattenActions(sections).map((a) => a.kind)).toEqual([
      "talk",
      "readLatest",
      "toggleConverse",
      "toggleTarget",
      "readReply",
    ]);
  });
});
