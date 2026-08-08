import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("composer add-menu contract", () => {
  it("keeps composer context and capture actions without a New chat action", () => {
    const source = readSource("app/chat/ComposerAddMenu.tsx");

    expect(source).toContain("<DropdownMenuLabel>Context</DropdownMenuLabel>");
    expect(source).toContain("Capture");
    expect(source).toContain("Select area");
    expect(source).toContain("Attach files…");

    expect(source).not.toContain("onNewChat");
    expect(source).not.toContain("New chat");
    expect(source).not.toContain("newChatArmed");
    expect(source).not.toContain("newChatPending");
    expect(source).not.toContain("showToast");

    const captureIndex = source.search(/>\s*Capture\s*</);
    const selectAreaIndex = source.search(/>\s*Select area\s*</);
    const attachFilesIndex = source.search(/>\s*Attach files…\s*</);
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(selectAreaIndex).toBeGreaterThan(captureIndex);
    expect(attachFilesIndex).toBeGreaterThan(selectAreaIndex);
  });

  it("removes composer-only New chat wiring from both render variants", () => {
    for (const relativePath of [
      "app/chat/Composer.tsx",
      "app/chat/ChatColumn.tsx",
      "shell/ChatSidebar.tsx",
      "shell/display/default-tabs.tsx",
      "shell/use-full-shell-chat.js",
    ]) {
      const source = readSource(relativePath);
      expect(source, relativePath).not.toContain("onNewChat");
      expect(source, relativePath).not.toContain("startNewChat");
    }

    const fullComposer = readSource("app/chat/Composer.tsx");
    const sidebarComposer = readSource("shell/ChatSidebar.tsx");
    expect(fullComposer.match(/<ComposerAddMenu/g)).toHaveLength(2);
    expect(sidebarComposer.match(/<ComposerAddMenu/g)).toHaveLength(2);
  });

  it("leaves the labeled top-bar New chat control canonical", () => {
    const source = readSource("shell/topbar/ConversationTopBar.tsx");

    expect(source).toContain('aria-label="New chat"');
    expect(source).toContain(
      '<span className="conversation-topbar__new-label">New chat</span>',
    );
  });
});
