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
  it("keeps Models in Work's lower half without replacing Work", () => {
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
    expect(home).not.toContain("showModels");

    expect(work).toContain('className="work-section__footer"');
    expect(work).toContain("<SidebarModelsControl />");
    expect(work).toContain('className="work-section__primary"');
    expect(work).toContain("data-models-open={modelsOpen || undefined}");
    expect(work.indexOf("<WorkList />")).toBeLessThan(
      work.indexOf('className="work-models-panel"'),
    );
    expect(work).toContain("<AgentModelPicker active={modelsActive}/>");

    expect(control).not.toContain("ModelsPicker");
    expect(control).toContain("onClick={engineOverlay.toggle}");
    expect(styles).toContain(".work-section__footer {");
    expect(styles).toContain(".work-section__primary {");
    expect(styles).toContain(".work-models-panel {");
    expect(styles).toContain("flex: 0 0 50%;");
    expect(styles).toContain("max-height: 50%;");
  });
});
