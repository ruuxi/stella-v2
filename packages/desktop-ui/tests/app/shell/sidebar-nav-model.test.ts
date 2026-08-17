// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_SIDEBAR_SECTIONS,
  SIDEBAR_SECTIONS,
  resolveSidebarSection,
  sidebarSections,
} from "@/features/workspace-display/sidebar-sections";
import {
  HOME_LAUNCHER_SECTIONS,
  SIDEBAR_SECTION_META,
} from "@/shell/sidebar-sections/section-meta";
import { displayTabs } from "@/features/workspace-display/tab-store";

describe("right-sidebar navigation model (browser-tab style)", () => {
  beforeEach(() => {
    sidebarSections.reset();
    displayTabs.setPanelOpen(false);
  });

  it("exposes Home + Quick chat as real panel sections", () => {
    expect(SIDEBAR_SECTIONS).toEqual([
      "home",
      "quickchat",
      "files",
      "apps",
      "browser",
    ]);
    // Every section, Home included, now renders inside the panel body.
    expect(PANEL_SIDEBAR_SECTIONS).toContain("home");
    expect(PANEL_SIDEBAR_SECTIONS).toContain("quickchat");
  });

  it("offers Quick chat / Files / Apps / Browser as launcher options (search excluded)", () => {
    expect(HOME_LAUNCHER_SECTIONS).toEqual([
      "quickchat",
      "files",
      "apps",
      "browser",
    ]);
    expect(HOME_LAUNCHER_SECTIONS).not.toContain("home");
    expect(SIDEBAR_SECTION_META.quickchat.label).toBe("Quick chat");
    expect(SIDEBAR_SECTION_META.files.label).toBe("Files");
    expect(SIDEBAR_SECTION_META.home.label).toBe("Home");
  });

  it("keeps legacy ids mapping to Home", () => {
    expect(resolveSidebarSection("tasks")).toBe("home");
    expect(resolveSidebarSection("search")).toBe("home");
    expect(resolveSidebarSection("settings")).toBe("home");
    expect(resolveSidebarSection("nonsense")).toBe("home");
  });

  it("selecting a section opens the panel; Home stays a real in-panel view", () => {
    sidebarSections.selectSection("quickchat");
    expect(sidebarSections.getSnapshot().activeSection).toBe("quickchat");
    expect(displayTabs.getSnapshot().panelOpen).toBe(true);

    // Home no longer closes the panel — it is the launcher.
    sidebarSections.openHomeLauncher();
    expect(sidebarSections.getSnapshot().activeSection).toBe("home");
    expect(displayTabs.getSnapshot().panelOpen).toBe(true);
  });

  it("re-selecting the active drilled section returns it to its list", () => {
    sidebarSections.openLocation("files", "tab-123");
    expect(sidebarSections.getSnapshot().activeSection).toBe("files");
    expect(sidebarSections.getSnapshot().locations.files).toBe("tab-123");

    sidebarSections.selectSection("files");
    expect(sidebarSections.getSnapshot().locations.files).toBeNull();
  });

  it("'+' opens a NEW Home tab alongside the current view (does not replace it)", () => {
    // Open Files.
    sidebarSections.selectSection("files");
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files"]);

    // "+" adds a Home tab and activates it — Files stays open.
    sidebarSections.openHomeLauncher();
    expect(sidebarSections.getSnapshot().activeSection).toBe("home");
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files", "home"]);
  });

  it("navigating from the empty Home tab consumes it (browser new-tab)", () => {
    sidebarSections.selectSection("files"); // openTabs: [files]
    sidebarSections.openHomeLauncher(); // openTabs: [files, home], active home
    // Picking a destination from the Home launcher turns that empty tab into it.
    sidebarSections.selectSection("apps");
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files", "apps"]);
    expect(sidebarSections.getSnapshot().activeSection).toBe("apps");
  });

  it("activateTab switches between coexisting tabs without adding/removing any", () => {
    sidebarSections.selectSection("files");
    sidebarSections.openHomeLauncher();
    sidebarSections.selectSection("browser"); // [files, browser], active browser
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files", "browser"]);

    sidebarSections.activateTab("files");
    expect(sidebarSections.getSnapshot().activeSection).toBe("files");
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files", "browser"]);
  });

  it("closing a tab activates a neighbor; closing the last closes the panel", () => {
    sidebarSections.selectSection("files");
    sidebarSections.openHomeLauncher();
    sidebarSections.selectSection("apps"); // [files, apps], active apps

    sidebarSections.closeTab("apps");
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["files"]);
    expect(sidebarSections.getSnapshot().activeSection).toBe("files");

    sidebarSections.closeTab("files");
    expect(displayTabs.getSnapshot().panelOpen).toBe(false);
    expect(sidebarSections.getSnapshot().openTabs).toEqual(["home"]);
  });
});
