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
  it("hosts Models as a footer popover anchored in Home", () => {
    const panel = readSource("shell/RightSidebar.tsx");
    const home = readSource("shell/WorkspaceHomeSurface.tsx");
    const work = readSource("shell/sidebar-sections/FilesSection.jsx");
    const control = readSource(
      "shell/sidebar-sections/SidebarModelsControl.jsx",
    );
    const styles = readSource("shell/sidebar-sections/files-section.css");

    expect(panel).not.toContain("SidebarModelsControl");
    expect(panel).not.toContain("right-sidebar-models-footer");
    expect(home).toContain("<HomeSection />");
    expect(home).not.toContain("AgentModelPicker");

    // The workspace strip (panel closed) carries Models alone — the rest of
    // the utility cluster stays in the panel's Home footer — and its Models
    // button opens the popover in place instead of opening the panel.
    expect(home).not.toContain("<SidebarUtilityControls />");
    expect(home).toMatch(
      /<SidebarModelsControl\s+active=\{!surfaceHidden\}\s*\/>/,
    );
    expect(home).not.toContain("setPanelOpen");

    // Home's footer is the popover anchor; the section body never swaps to
    // an inline models panel, and it stays visible when the picker is
    // opened externally while a viewer tab is showing.
    expect(work).toContain('className="work-section__footer"');
    expect(work).toContain("<SidebarUtilityControls />");
    expect(work).toContain("<SidebarModelsControl active={modelsActive}/>");
    expect(work).toContain("const showFooter = modelsOpen || !openTab;");
    expect(work).toContain("{showFooter ?");
    expect(work).not.toContain("AgentModelPicker");

    // The picker renders inside the control's popover, driven by the shared
    // engine-overlay store so `openEngineDisplayTab()` and the
    // `stella:open-model-picker` event keep working. The control itself
    // never moves the sidebar, and `active` decides which of the two
    // mounted footers anchors the shared popover.
    expect(control).toContain("PopoverTrigger");
    expect(control).toContain("AgentModelPicker");
    expect(control).toContain("engineOverlay.setOpen");
    expect(control).toContain("const open = modelsPickerOpen && active;");
    expect(control).not.toContain("setPanelOpen");
    expect(control).not.toContain("setActiveSection");

    expect(styles).toContain(".work-section__footer {");
    expect(styles).toContain(".models-popover {");
    expect(styles).toContain(".pill-btn.work-models-button[data-active]");
    expect(styles).not.toContain(".work-models-panel {");
  });
});
