import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHELL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/shell",
);

describe("left sidebar shell", () => {
  it("shares one flat canvas with the main content", () => {
    const sidebar = fs.readFileSync(
      path.join(SHELL_ROOT, "LeftSidebar.tsx"),
      "utf8",
    );
    const sidebarCss = fs.readFileSync(
      path.join(SHELL_ROOT, "left-sidebar.css"),
      "utf8",
    );
    const junctionCss = fs.readFileSync(
      path.join(SHELL_ROOT, "shell-junction.css"),
      "utf8",
    );

    expect(sidebar).not.toContain("left-sidebar__nav");
    expect(sidebarCss).not.toContain(".left-sidebar__nav");

    const frame = sidebarCss.match(/\.left-sidebar__frame\s*\{([^}]*)\}/);
    expect(frame?.[1]).toMatch(/background:\s*transparent/);
    expect(frame?.[1]).toMatch(/border:\s*none/);

    const contentJunction = junctionCss.match(
      /:root\[data-shell-panel-chrome="true"\]\s+\.content-area\s*\{([^}]*)\}/,
    );
    expect(contentJunction?.[1]).toMatch(/border-left:\s*none/);
    expect(contentJunction?.[1]).toMatch(/border-radius:\s*0/);
    expect(contentJunction?.[1]).toMatch(/box-shadow:\s*none/);

    const sidebarJunction = junctionCss.match(
      /:root\[data-shell-panel-chrome="true"\]\s+\.left-sidebar__frame\s*\{([^}]*)\}/,
    );
    expect(sidebarJunction?.[1]).toMatch(/background:\s*transparent/);
    expect(sidebarJunction?.[1]).toMatch(/border:\s*none/);
    expect(sidebarJunction?.[1]).toMatch(/border-radius:\s*0/);
    expect(sidebarJunction?.[1]).toMatch(/box-shadow:\s*none/);
    expect(junctionCss).not.toContain(".full-body::before");
  });
});
