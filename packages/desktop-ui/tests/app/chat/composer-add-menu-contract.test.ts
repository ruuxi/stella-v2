import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import enCatalog from "../../../src/shared/i18n/locales/en.json";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

/**
 * These labels used to be asserted as literal JSX text. They are now
 * `t()` keys, so the contract is checked in two halves: the source
 * renders the key in the right slot, and the English catalog still maps
 * that key to the copy this contract is about. Checking only the key
 * would let the copy drift silently; checking only the copy would miss
 * the label being moved to a different control.
 */
const englishFor = (key: string): string => {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      enCatalog,
    );
  expect(typeof value, `${key} missing from en.json`).toBe("string");
  return value as string;
};

describe("composer add-menu contract", () => {
  it("keeps composer context and capture actions without a New chat action", () => {
    const source = readSource("app/chat/ComposerAddMenu.tsx");

    expect(englishFor("app.chat.addMenu.context")).toBe("Context");
    expect(englishFor("app.chat.addMenu.capture")).toBe("Capture");
    expect(englishFor("app.chat.addMenu.attachFiles")).toBe("Attach files…");

    // Whitespace-tolerant: prettier reflows this across lines once the
    // literal becomes a t() call.
    expect(source).toMatch(
      /<DropdownMenuLabel>\s*\{t\("app\.chat\.addMenu\.context"\)\}\s*<\/DropdownMenuLabel>/,
    );

    // No New chat affordance here — it is the top bar's, and only the
    // top bar's. Guard the key as well as the literal so the extraction
    // cannot smuggle it back in.
    expect(source).not.toContain("onNewChat");
    expect(source).not.toContain("New chat");
    expect(source).not.toContain("newChat");
    expect(source).not.toContain("newChatArmed");
    expect(source).not.toContain("newChatPending");
    expect(source).not.toContain("showToast");

    const captureIndex = source.indexOf('t("app.chat.addMenu.capture")');
    const attachFilesIndex = source.indexOf(
      't("app.chat.addMenu.attachFiles")',
    );
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(attachFilesIndex).toBeGreaterThan(captureIndex);
    expect(source).not.toContain("selectArea");
    expect(source).not.toContain("onSelectArea");
    expect(source).not.toContain("Select area");
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

    expect(englishFor("shell.topbar.conversation.newChat")).toBe("New chat");
    expect(source).toContain(
      'aria-label={t("shell.topbar.conversation.newChat")}',
    );
    expect(source).toContain('className="conversation-topbar__new-label"');
    expect(source).toMatch(
      /conversation-topbar__new-label"\s*>\s*\{t\("shell\.topbar\.conversation\.newChat"\)\}/,
    );
  });
});
