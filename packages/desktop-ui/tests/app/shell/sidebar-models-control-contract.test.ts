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
  it("keeps one picker on the visible bottom-right surface", () => {
    const panel = readSource("shell/RightSidebar.jsx");
    const home = readSource("shell/WorkspaceHomeSurface.jsx");
    const styles = readSource("shell/right-sidebar-panel.css");

    expect(panel).toContain('className="right-sidebar-models-footer"');
    expect(panel).toContain("{panelOpen ? (");
    expect(panel).toContain("<SidebarModelsControl />");

    expect(home).toContain("<HomeSection showModels={!surfaceHidden}/>");

    expect(styles).toContain(".right-sidebar-models-footer {");
    expect(styles).toContain("flex: 0 0 auto;");
    expect(styles).not.toContain(".right-sidebar-models-island");
  });
});
