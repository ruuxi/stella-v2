import { describe, expect, test } from "bun:test";
import {
  buildHome,
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
  signedIn: true,
  now: NOW,
};

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
  test("future/clock-skew clamps to 'now'", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("now");
  });
});

describe("recent reply rows", () => {
  const replies = [
    { id: "m2", text: "Newest reply about the weather.", at: NOW - 2 * 60_000 },
    { id: "m1", text: "Older reply about dinner plans.", at: NOW - 3_600_000 },
  ];

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

describe("guest home", () => {
  test("offers sign-in instead of a talk row that could never answer", () => {
    const sections = buildHome({ ...base, signedIn: false });
    expect(sections.length).toBe(1);
    expect(sections[0].rows.length).toBe(1);
    expect(sections[0].rows[0].item.text).toBe("Sign in to talk to Stella");
    expect(flattenActions(sections)).toEqual([{ kind: "signInHint" }]);
  });

  test("a guest never sees replies from a previous signed-in drive", () => {
    const sections = buildHome({
      ...base,
      signedIn: false,
      replies: [{ id: "m2", text: "Newest.", at: NOW }],
    });
    expect(flattenActions(sections).map((a) => a.kind)).toEqual([
      "signInHint",
    ]);
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

  test("pairing changes nothing on the home: placement is invisible", () => {
    const sections = buildHome({
      ...base,
      replies: [{ id: "m2", text: "Newest.", at: NOW }],
    });
    expect(flattenActions(sections).map((a) => a.kind)).toEqual([
      "talk",
      "readLatest",
      "toggleConverse",
      "readReply",
    ]);
  });
});
