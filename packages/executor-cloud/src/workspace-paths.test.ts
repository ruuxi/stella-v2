import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  WORLD_DRIVE_ROOT,
  WORLD_DRIVE_WORKSPACE,
  WORLD_ROOT,
  toolStateDir,
} from "./workspace-paths.js";

describe("cloud workspace paths", () => {
  test("keeps Drive hydration state below the Drive root and separate from tool-host state", () => {
    const relative = path.relative(
      WORLD_DRIVE_WORKSPACE.root,
      WORLD_DRIVE_WORKSPACE.stateDir,
    );

    expect(WORLD_DRIVE_WORKSPACE.root).toBe(WORLD_DRIVE_ROOT);
    expect(relative).toBe(".stella");
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative.startsWith("..")).toBe(false);
    expect(WORLD_DRIVE_WORKSPACE.stateDir).not.toBe(toolStateDir(WORLD_ROOT));
  });
});
