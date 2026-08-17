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

  it("resets to a single Home tab", () => {
    const snap = sidebarSections.getSnapshot();
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0]!.kind).toBe("home");
    expect(snap.activeTabId).toBe(snap.tabs[0]!.id);
  });

  it("a launcher pick morphs the empty Home tab into that item + opens the panel", () => {
    sidebarSections.openLocation("files", "file-a");
    const snap = sidebarSections.getSnapshot();
    expect(snap.tabs).toHaveLength(1);
    expect(snap.tabs[0]!.kind).toBe("files");
    expect(snap.tabs[0]!.location).toBe("file-a");
    expect(displayTabs.getSnapshot().panelOpen).toBe(true);
  });

  it("'+' opens a NEW Home tab alongside the current one (does not replace it)", () => {
    sidebarSections.openLocation("files", "file-a");
    sidebarSections.openHomeLauncher();
    const snap = sidebarSections.getSnapshot();
    expect(snap.tabs.map((tab) => tab.kind)).toEqual(["files", "home"]);
    expect(snap.activeTabId).toBe(snap.tabs[1]!.id);
  });

  it("opening two files yields two INDEPENDENT file tabs (per item, not per section)", () => {
    sidebarSections.openLocation("files", "file-a"); // morphs Home -> file-a
    sidebarSections.openHomeLauncher(); // new empty Home tab
    sidebarSections.openLocation("files", "file-b"); // morphs it -> file-b
    const fileTabs = sidebarSections
      .getSnapshot()
      .tabs.filter((tab) => tab.kind === "files");
    expect(fileTabs).toHaveLength(2);
    expect(fileTabs.map((tab) => tab.location)).toEqual(["file-a", "file-b"]);
  });

  it("opening an item from a NON-home tab creates a new tab (no morph)", () => {
    sidebarSections.openLocation("quickchat", null); // Home -> quickchat
    sidebarSections.openLocation("files", "file-a"); // active is quickchat -> new tab
    expect(
      sidebarSections.getSnapshot().tabs.map((tab) => tab.kind),
    ).toEqual(["quickchat", "files"]);
  });

  it("activateTab switches by id; closeTab activates a neighbor / closes on last", () => {
    sidebarSections.openLocation("files", "file-a"); // [file-a]
    sidebarSections.openHomeLauncher(); // [file-a, home]
    sidebarSections.openLocation("browser", null); // morph home -> [file-a, browser]
    const snap = sidebarSections.getSnapshot();
    const fileTabId = snap.tabs[0]!.id;
    const browserTabId = snap.tabs[1]!.id;

    sidebarSections.activateTab(fileTabId);
    expect(sidebarSections.getSnapshot().activeTabId).toBe(fileTabId);

    sidebarSections.closeTab(browserTabId);
    expect(
      sidebarSections.getSnapshot().tabs.map((tab) => tab.kind),
    ).toEqual(["files"]);

    sidebarSections.closeTab(fileTabId);
    expect(displayTabs.getSnapshot().panelOpen).toBe(false);
    expect(
      sidebarSections.getSnapshot().tabs.map((tab) => tab.kind),
    ).toEqual(["home"]);
  });
});
