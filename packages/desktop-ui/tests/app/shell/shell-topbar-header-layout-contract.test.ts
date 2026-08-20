// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clampDesktopUpdatePercent,
  splitUpdatePillDownloadingLabel,
} from "@/shell/ShellTopBarUpdatePill";
import enCatalog from "../../../src/shared/i18n/locales/en.json";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const read = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("full-window header layout contract", () => {
  it("pins the updater as a right-side action immediately before account controls", () => {
    const source = read("shell/ShellTopBarFull.tsx");
    const leftStart = source.indexOf('className="shell-topbar-full__left"');
    const rightStart = source.indexOf('className="shell-topbar-full__right"');
    const pill = source.indexOf("<ShellTopBarUpdatePill");
    const account = source.indexOf("<ShellTopBarAccount");

    expect(leftStart).toBeGreaterThan(-1);
    expect(rightStart).toBeGreaterThan(leftStart);
    expect(pill).toBeGreaterThan(rightStart);
    expect(account).toBeGreaterThan(pill);
    expect(source.slice(leftStart, rightStart)).not.toContain(
      "ShellTopBarUpdatePill",
    );
    expect(source.slice(rightStart)).toMatch(
      /<ShellTopBarUpdatePill \/>\s*<ShellTopBarAccount/,
    );
  });

  it("lets tabs consume leftover middle space without hardcoded right-side offsets", () => {
    const fullCss = read("shell/shell-topbar-full.css");
    const tabCss = read("shell/topbar/conversation-topbar.css");

    expect(fullCss).toMatch(
      /\.shell-topbar-full__left\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
    );
    expect(fullCss).toMatch(
      /\.shell-topbar-full__left:has\(\.conversation-topbar__viewport\)\s*\{[^}]*flex:\s*1 1 auto;[^}]*padding-right:\s*0;/,
    );
    expect(fullCss).toMatch(
      /\.shell-topbar-full__left:has\(\.conversation-topbar__viewport\) \.conversation-topbar\s*\{[^}]*flex:\s*1 1 auto;/,
    );
    expect(fullCss).toMatch(
      /\.shell-topbar-full__right\s*\{[^}]*flex:\s*0 0 auto;/,
    );
    expect(fullCss).toMatch(
      /\.shell-topbar-full__right \.shell-topbar-update-pill\s*\{[^}]*flex:\s*0 0 auto;/,
    );
    expect(fullCss).toMatch(
      /\.shell-topbar-full__left \.shell-topbar-nav:empty\s*\{[^}]*display:\s*none;/,
    );
    expect(tabCss).toMatch(
      /\.conversation-topbar__viewport\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*28px;/,
    );
    expect(tabCss).not.toMatch(
      /max-width:\s*calc\(100%\s*-\s*(116|68)px\)/,
    );
    expect(fullCss).not.toMatch(/--shell-topbar-update-pill-width/);
  });

  it("keeps account, panel, and window-control actions after the updater", () => {
    const source = read("shell/ShellTopBarFull.tsx");
    const right = source.slice(
      source.indexOf('className="shell-topbar-full__right"'),
    );

    expect(right).toContain("<ShellTopBarAccount onSignIn={onSignIn} />");
    expect(right).toContain("{isWin && !panelOpen ? (");
    expect(right).toContain("<WindowControls useWindowsIcons hidden={false} />");
    expect(right).toContain("displayTabs.setPanelOpen(true)");
  });
});

describe("updater label stability", () => {
  it("reserves a three-digit tabular slot for download progress", () => {
    const css = read("shell/shell-topbar-update-pill.css");
    const source = read("shell/ShellTopBarUpdatePill.tsx");

    expect(source).toContain("splitUpdatePillDownloadingLabel(");
    expect(source).toContain('className="shell-topbar-update-pill__percent"');
    expect(css).toMatch(
      /\.shell-topbar-update-pill__percent\s*\{[^}]*min-width:\s*3ch;[^}]*text-align:\s*end;[^}]*font-variant-numeric:\s*tabular-nums;/,
    );
    expect(enCatalog.shell.updatePill.downloading).toBe(
      "Downloading {percent}%",
    );
  });

  it("keeps 9, 10, 99, and 100 on the same reserved digit width", () => {
    const template = enCatalog.shell.updatePill.downloading;
    const samples = [0, 9, 10, 99, 100].map((percent) =>
      splitUpdatePillDownloadingLabel(template, percent),
    );

    expect(new Set(samples.map((part) => part.prefix))).toEqual(
      new Set(["Downloading "]),
    );
    expect(new Set(samples.map((part) => part.suffix))).toEqual(new Set(["%"]));
    expect(samples.map((part) => part.value)).toEqual([
      "0",
      "9",
      "10",
      "99",
      "100",
    ]);
    expect(clampDesktopUpdatePercent(9.4)).toBe(9);
    expect(clampDesktopUpdatePercent(99.6)).toBe(100);
    expect(clampDesktopUpdatePercent(-3)).toBe(0);
    expect(clampDesktopUpdatePercent(140)).toBe(100);
  });
});
