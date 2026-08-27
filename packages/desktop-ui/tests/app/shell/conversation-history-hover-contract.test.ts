import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("conversation history interaction contract", () => {
  it("opens on hover without regressing bounded scroll pagination", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );

    expect(source).toContain("const HISTORY_HOVER_CLOSE_DELAY_MS = 120");
    expect(source).toContain("onPointerEnter={(event) => {");
    expect(source).toContain("openHistoryFromHover()");
    expect(source).toContain("scheduleHistoryCloseFromHover()");
    expect(source).toContain("event.preventDefault()");

    expect(source).toContain("const HISTORY_PAGE_SIZE = 50");
    expect(source).toContain("getMyConversationHistorySnapshot");
    expect(source).toContain("snapshotUpdatedAt:");
    expect(source).toContain("frozenHistorySnapshot");
    expect(source).toContain("mergeCloudConversationHistory(");
    expect(source).toContain("paginatedHistory.loadMore(HISTORY_PAGE_SIZE)");
    expect(source).not.toContain("listLocalConversations");
    expect(source).toContain("<LegendList<ConversationSummary>");
    expect(source).toContain("recycleItems");
    expect(source).toContain("onEndReached={() => {");
  });
});
