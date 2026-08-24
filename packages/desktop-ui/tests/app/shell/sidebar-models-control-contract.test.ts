import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldShowGlobalModelsControl } from "@/shell/global-models-control-visibility";
import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(SOURCE_ROOT, relativePath), "utf8");

describe("global Models control placement", () => {
  it("hosts Models as a single top-level control, never in the sidebar footers", () => {
    const root = readSource("routes/__root.tsx");
    const panel = readSource("shell/RightSidebar.tsx");
    const home = readSource("shell/WorkspaceHomeSurface.tsx");
    const work = readSource("shell/sidebar-sections/FilesSection.jsx");
    const control = readSource("shell/GlobalModelsControl.jsx");
    const defaultTabs = readSource("shell/display/default-tabs.tsx");
    const styles = readSource("shell/global-models-control.css");

    expect(root).toContain(
      'import { GlobalModelsControl } from "@/shell/GlobalModelsControl"',
    );
    expect(root).toMatch(
      /<GlobalModelsControl\s+visible=\{modelControlVisible\}\s*\/>/,
    );

    expect(panel).not.toContain("SidebarModelsControl");
    expect(panel).not.toContain("GlobalModelsControl");
    expect(panel).not.toContain("right-sidebar-models-footer");

    expect(home).toContain("<HomeSection />");
    expect(home).not.toContain("SidebarModelsControl");
    expect(home).not.toContain("AgentModelPicker");
    expect(home).not.toContain("SidebarUtilityControls");
    expect(home).not.toContain("setPanelOpen");

    expect(work).not.toContain("SidebarModelsControl");
    expect(work).not.toContain("AgentModelPicker");
    expect(work).not.toContain("SidebarUtilityControls");

    expect(control).toContain("PopoverTrigger");
    expect(control).toContain("AgentModelPicker");
    expect(control).toContain("engineOverlay.setOpen");
    expect(control).toContain("useEngineOverlayOpen");
    expect(control).not.toContain("setPanelOpen");
    expect(control).not.toContain("setActiveSection");
    expect(defaultTabs).toContain("displayTabs.setPanelOpen(true)");
    expect(defaultTabs).toContain('sidebarSections.selectSection("home")');

    expect(styles).toContain(".global-models-control {");
    expect(styles).toContain(".models-popover {");
    expect(styles).toContain(".pill-btn.work-models-button {");
  });

  it.each([
    ["closed with no Activity", false, "home", false],
    ["closed while Activity is displayed", false, "home", false],
    [
      "closed while qualifying Activity is breakpoint-hidden",
      false,
      "home",
      false,
    ],
    ["open on Home", true, "home", true],
    ["open on Files", true, "files", true],
    ["open on Apps", true, "apps", true],
    ["open on Browser", true, "browser", true],
    ["open on Quick chat", true, "quickchat", false],
  ] as const)(
    "%s",
    (_label, panelOpen, activeSidebarSection, expected) => {
      expect(
        shouldShowGlobalModelsControl({
          panelOpen,
          activeSidebarSection: activeSidebarSection as SidebarSection,
        }),
      ).toBe(expected);
    },
  );

  it("does not derive Models visibility from Activity qualification", () => {
    const root = readSource("routes/__root.tsx");
    expect(root).not.toContain("useHasQualifyingActivity");
    expect(root).not.toContain("hasQualifyingActivity");
  });
});
