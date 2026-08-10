// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getContextSuggestionLabel } from "@/app/chat/ComposerAddMenu";
import { shouldShowActivityPill } from "@/app/chat/ComposerActivityPill";
import { isComposerContextMenuTarget } from "@/shell/context-menu/StellaContextMenu";
import type { ComposerContextSuggestion } from "@/app/chat/ComposerContextRow";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("chat shell UI contracts", () => {
  it("shows the activity pill only when the workspace strip cannot carry it", () => {
    // With the display panel open the pill rides alongside it; with the strip
    // hidden the pill is the only surface left. No activity, no pill.
    expect(shouldShowActivityPill(true, true, false)).toBe(true);
    expect(shouldShowActivityPill(true, false, true)).toBe(true);
    expect(shouldShowActivityPill(true, false, false)).toBe(false);
    expect(shouldShowActivityPill(false, true, true)).toBe(false);
  });

  it("labels app and browser context options for the + menu", () => {
    const app: ComposerContextSuggestion = {
      key: "app:42",
      phase: "stable",
      chip: {
        kind: "app",
        pid: 42,
        name: "System Settings",
        windowTitle: "Privacy & Security",
        isActive: true,
      },
    };
    const tab: ComposerContextSuggestion = {
      key: "tab:safari",
      phase: "stable",
      chip: {
        kind: "tab",
        browser: "Safari",
        bundleId: "com.apple.Safari",
        url: "https://chatgpt.com/",
        host: "chatgpt.com",
        title: "ChatGPT",
      },
    };

    expect(getContextSuggestionLabel(app)).toBe(
      "System Settings — Privacy & Security",
    );
    expect(getContextSuggestionLabel(tab)).toBe("Safari — ChatGPT");
  });

  it("allows native context menus inside composer forms only", () => {
    const form = document.createElement("form");
    form.dataset.composerContextMenu = "native";
    const textarea = document.createElement("textarea");
    form.appendChild(textarea);
    const outside = document.createElement("div");

    expect(isComposerContextMenuTarget(textarea)).toBe(true);
    expect(isComposerContextMenuTarget(form)).toBe(true);
    expect(isComposerContextMenuTarget(outside)).toBe(false);
  });

  it("moves suggestion UI into the + menu", () => {
    const leadRow = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerLeadRow.tsx"),
      "utf8",
    );
    const addMenu = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerAddMenu.tsx"),
      "utf8",
    );
    expect(leadRow).not.toContain("ComposerSuggestionContextRow");
    // The label is localized, so pin the key rather than the English string.
    expect(addMenu).toContain('t("app.chat.addMenu.context")');
  });

  it("shows Windows window controls only while the right sidebar is closed", () => {
    const mainTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/ShellTopBarFull.tsx"),
      "utf8",
    );
    const panelTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/DisplayPanelTopBar.tsx"),
      "utf8",
    );

    expect(mainTopBar).toContain("{isWin && !panelOpen ? (");
    expect(mainTopBar).toContain(
      "<WindowControls useWindowsIcons hidden={false} />",
    );
    expect(panelTopBar).not.toContain("WindowControls");
  });
});
