import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const read = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
};

describe("frameless window drag regions", () => {
  it("keeps the main header and tab viewport draggable around no-drag controls", () => {
    const source = read("shell/ShellTopBarFull.tsx");
    const headerCss = read("shell/shell-topbar-full.css");
    const tabsCss = read("shell/topbar/conversation-topbar.css");
    const controlsCss = read("shell/full-shell.layout.css");
    const navCss = read("shell/sidebar/topbar-nav.css");
    const updaterCss = read("shell/shell-topbar-update-pill.css");

    expect(source).toContain('className="shell-topbar-full__spacer"');
    expect(rule(headerCss, ".shell-topbar-full")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(headerCss, ".shell-topbar-full__left")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(headerCss, ".shell-topbar-full__spacer")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(headerCss, ".shell-topbar-full__right")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar__viewport")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar__tabs")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar__tab")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar__tab-target")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".conversation-topbar__tab-close")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(controlsCss).toMatch(
      /\.shell-topbar-icon-btn,[\s\S]*?\.shell-topbar-wc-btn\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    );
    expect(rule(navCss, ".shell-topbar-nav")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(navCss, ".shell-topbar-account")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(updaterCss, ".shell-topbar-update-pill")).toContain(
      "-webkit-app-region: no-drag;",
    );
  });

  it("keeps the right-sidebar filler draggable around its tab strip and controls", () => {
    const source = read("shell/DisplayPanelTopBar.tsx");
    const headerCss = read("shell/shell-topbar-full.css");
    const tabsCss = read("shell/sidebar-sections/sidebar-top-nav.css");

    expect(source).toMatch(
      /className="display-panel-topbar__tabs"[\s\S]*<SidebarTopNav \/>/,
    );
    expect(rule(headerCss, ".display-panel-topbar")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(headerCss, ".display-panel-topbar__tabs")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav")).toContain(
      "-webkit-app-region: drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav__tabs")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav__tab")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav__tab-target")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav__tab-close")).toContain(
      "-webkit-app-region: no-drag;",
    );
    expect(rule(tabsCss, ".sidebar-top-nav__plus")).toContain(
      "-webkit-app-region: no-drag;",
    );
  });
});
