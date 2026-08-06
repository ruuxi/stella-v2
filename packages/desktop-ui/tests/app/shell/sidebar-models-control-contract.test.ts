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

describe("sidebar Models control placement", () => {
  it("keeps Models inside Work and swaps that section instead of using a popover", () => {
    const panel = readSource("shell/RightSidebar.jsx");
    const home = readSource("shell/WorkspaceHomeSurface.jsx");
    const work = readSource("shell/sidebar-sections/FilesSection.jsx");
    const control = readSource(
      "shell/sidebar-sections/SidebarModelsControl.jsx",
    );
    const styles = readSource("shell/sidebar-sections/files-section.css");

    expect(panel).not.toContain("SidebarModelsControl");
    expect(panel).not.toContain("right-sidebar-models-footer");
    expect(home).toContain("<HomeSection />");
    expect(home).toContain("<SidebarModelsControl openSidebar/>");
    expect(home).not.toContain("AgentModelPicker");

    expect(work).toContain('className="work-section__footer"');
    expect(work).toContain("<SidebarModelsControl />");
    expect(work).toContain("modelsOpen ?");
    expect(work).toContain("<AgentModelPicker active={modelsActive}/>");

    expect(control).not.toContain("ModelsPicker");
    expect(control).toContain('sidebarSections.setActiveSection("files")');
    expect(control).toContain("displayTabs.setPanelOpen(true)");
    expect(control).toContain("engineOverlay.setOpen(true)");
    expect(control).toContain("engineOverlay.toggle()");
    expect(styles).toContain(".work-section__footer {");
    expect(styles).toContain(".work-models-panel {");
  });
});
