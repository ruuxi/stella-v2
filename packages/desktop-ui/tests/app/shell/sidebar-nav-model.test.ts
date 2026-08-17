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
});
