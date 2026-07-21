import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHELL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/shell",
);
const SOURCE_ROOT = path.resolve(SHELL_ROOT, "..");

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

  it("keeps account and settings out of Activity and in top-shell chrome", () => {
    const sidebar = fs.readFileSync(
      path.join(SHELL_ROOT, "LeftSidebar.tsx"),
      "utf8",
    );
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );
    const rightSidebar = fs.readFileSync(
      path.join(SHELL_ROOT, "RightSidebar.tsx"),
      "utf8",
    );
    const account = fs.readFileSync(
      path.join(SHELL_ROOT, "sidebar/ShellTopBarAccount.tsx"),
      "utf8",
    );

    expect(sidebar).not.toContain("ShellTopBarAccount");
    expect(sidebar).not.toContain("left-sidebar__footer");
    expect(root).toContain(
      '<div\n          className="shell-edge-right-cluster"',
    );
    expect(root).toContain("<ShellTopBarAccount");
    expect(root).toContain("showAccountControls={isFullWindow}");
    expect(rightSidebar).toContain("showAccountControls ? (");
    expect(rightSidebar).toContain("<ShellTopBarAccount");

    // The moved component remains the single owner of both auth states and
    // their existing accessible actions.
    expect(account).toContain("if (!hasConnectedAccount)");
    expect(account).toContain("onSignIn?.()");
    expect(account).toContain('aria-label={t("sidebar.signIn")}');
    expect(account).toContain('aria-label="Settings"');
    expect(account).toContain("shell-topbar-account-trigger--split");
    expect(account).toContain("handleOpenSettings");
  });

  it("collapses loaded-empty Activity to zero width with no toggle gutter", () => {
    const sidebarCss = fs.readFileSync(
      path.join(SHELL_ROOT, "left-sidebar.css"),
      "utf8",
    );
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );

    const collapsed = sidebarCss.match(
      /\.left-sidebar--collapsed\s*\{([^}]*)\}/,
    );
    const shell = sidebarCss.match(/\.left-sidebar\s*\{([^}]*)\}/);
    expect(collapsed?.[1]).toMatch(/width:\s*0/);
    expect(shell?.[1]).toMatch(/min-width:\s*0/);
    expect(root).toContain(
      "isFullWindow && activityPresenceAllowsSidebar(activityPresence)",
    );
    expect(root).toContain('dockedLeftSidebarVisible ? "252px" : "0px"');
  });
});
