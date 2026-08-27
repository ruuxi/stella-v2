import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");

describe("chat scroll performance contract", () => {
  it("does not enable Legend's forced-geometry onScroll adapter", () => {
    const timeline = readSource("src/app/chat/ChatTimeline.tsx");

    expect(timeline).not.toContain("onScroll={onListScroll}");
    expect(readSource("src/app/chat/ChatColumn.tsx")).toContain(
      "list.scrollToOffset({ offset: next, animated: false })",
    );
  });

  it("tracks scroll state from a passive native listener instead", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");

    expect(hook).toMatch(
      /addEventListener\(["']scroll["'], scheduleScrollStateUpdate, \{\s*passive: true,/,
    );
    expect(hook).toMatch(
      /attached\.removeEventListener\(["']scroll["'], scheduleScrollStateUpdate\)/,
    );
    expect(hook).toContain(
      "showScrollButton: showScrollButton || hasNewerEvents",
    );
  });

  it("notes manual scrolling from the native wheel listener", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");

    expect(hook).toContain("const noteManualScroll = useCallback");
    expect(hook).toMatch(
      /const handleWheel = \(event: WheelEvent\) => \{\s*noteManualScroll\(\)/,
    );
  });

  it("routes every tail growth through the single content-growth channel", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");
    const follow = readSource("src/shell/chat-scroll-follow.ts");

    expect(hook).not.toContain("followActiveAssistantRow");
    expect(hook).toContain("subscribeChatContentGrowth(");
    expect(follow).not.toContain("beginAssistantScrollFollow");
  });

  it("keeps send and turn reframes on the same gentle path across platforms", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");

    expect(hook).not.toContain("prefersReducedMotion");
    expect(hook).not.toContain('getAttribute("data-reduce-motion")');
    expect(hook).toContain("const gentle = Boolean(options.gentle)");
    expect(hook).toContain("if (followGentle)");
    expect(hook).toContain(
      "setTarget(target, { allowBackward: true, gentle: true })",
    );
  });
});
