import { describe, expect, it } from "vitest";
import { buildXBotCardTree, X_BOT_CARD_HEIGHT, X_BOT_CARD_WIDTH } from "./x_bot_card";

const collectText = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, out));
  } else if (node && typeof node === "object" && "props" in node) {
    collectText((node as { props: { children?: unknown } }).props.children, out);
  }
  return out;
};

const collectNodes = (node: unknown, out: Record<string, unknown>[] = []) => {
  if (Array.isArray(node)) {
    node.forEach((child) => collectNodes(child, out));
  } else if (node && typeof node === "object" && "props" in node) {
    const typed = node as { props: Record<string, unknown> };
    out.push(typed.props);
    collectNodes(typed.props.children, out);
  }
  return out;
};

describe("buildXBotCardTree", () => {
  const tree = buildXBotCardTree({
    headline: "I can set up that server for your friends.",
    handle: "poster",
    exchanges: [
      { user: "Set up a modded server", stella: "Installing Fabric now." },
      { user: "Invite them", stella: "Drafting the Discord message." },
    ],
    logoDataUri: "data:image/png;base64,AAAA",
  });

  it("is a fixed 16:9 frame carrying the headline, chat, and address", () => {
    expect(tree.props.style).toMatchObject({
      width: X_BOT_CARD_WIDTH,
      height: X_BOT_CARD_HEIGHT,
    });
    expect(X_BOT_CARD_WIDTH / X_BOT_CARD_HEIGHT).toBeCloseTo(16 / 9);
    const text = collectText(tree);
    expect(text).toContain("I can set up that server for your friends.");
    expect(text).toContain("stella.sh/x/poster");
    expect(text).toContain("Set up a modded server");
    expect(text).toContain("Drafting the Discord message.");
  });

  it("stays inside Satori's flexbox subset and avoids blur filters", () => {
    for (const props of collectNodes(tree)) {
      const style = (props.style ?? {}) as Record<string, unknown>;
      if (props.src === undefined) {
        expect(style.display ?? "flex").toBe("flex");
      }
      expect(style.filter).toBeUndefined();
      expect(style.boxShadow).toBeUndefined();
    }
  });
});
