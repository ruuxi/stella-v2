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
  it("shows Models in Work and Activity without making it global", () => {
    const panel = readSource("shell/RightSidebar.jsx");
    const home = readSource("shell/WorkspaceHomeSurface.jsx");
    const work = readSource("shell/sidebar-sections/FilesSection.jsx");
    const control = readSource(
      "shell/sidebar-sections/SidebarModelsControl.jsx",
    );
    const styles = readSource("shell/sidebar-sections/files-section.css");
    const controlStyles = readSource(
      "shell/sidebar-sections/sidebar-models-control.css",
    );

    expect(panel).not.toContain("SidebarModelsControl");
    expect(panel).not.toContain("right-sidebar-models-footer");
    expect(home).toContain("<HomeSection />");
    expect(home).not.toContain("showModels");
    expect(home).toContain("<SidebarModelsControl />");
    expect(home).toContain('className="workspace-home-surface__models"');
    expect(home).toContain(
      "<AgentModelPicker active={!surfaceHidden} mode={modelsMode}/>",
    );
    expect(home).not.toContain("openEngineDisplayTab");

    expect(work).toContain('className="work-section__footer"');
    expect(work).toContain("<SidebarModelsControl />");
    expect(work).toContain('className="work-section__primary"');
    expect(work).toContain("data-models-open={modelsOpen || undefined}");
    expect(work.indexOf("<WorkList />")).toBeLessThan(
      work.indexOf('className="work-models-panel"'),
    );
    expect(work).toContain(
      "<AgentModelPicker active={modelsActive} mode={modelsMode}/>",
    );

    expect(control).not.toContain("ModelsPicker");
    expect(control).toContain("onClick={engineOverlay.toggle}");
    expect(control).toContain('role="tablist" aria-label="Model type"');
    expect(control).toContain('modeButton("assistant", "Assistant"');
    expect(control).toContain('modeButton("image", "Image"');
    expect(control).toContain('modeButton("voice", "Voice"');
    expect(styles).toContain(".work-section__footer {");
    expect(styles).toContain(".work-section__primary {");
    expect(styles).toContain(".work-models-panel {");
    expect(styles).toContain("flex: 0 0 50%;");
    expect(styles).toContain("max-height: 50%;");
    expect(styles).toContain("border-top: 1px solid var(--border);");
    expect(controlStyles).toContain(".pill-btn.work-models-button {");
    expect(controlStyles).toContain(
      ".work-model-mode-button[data-active]",
    );
    expect(controlStyles).toContain(
      ".pill-btn.work-models-button[data-active]",
    );
    expect(controlStyles).toContain("border-color: var(--border-strong);");
  });
});
