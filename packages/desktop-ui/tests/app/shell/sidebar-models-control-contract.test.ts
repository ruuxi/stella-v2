import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

    expect(styles).toContain(".global-models-control {");
    expect(styles).toContain(".models-popover {");
    expect(styles).toContain(".pill-btn.work-models-button {");
  });
});
