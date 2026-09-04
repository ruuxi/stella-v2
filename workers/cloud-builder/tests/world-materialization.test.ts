import { describe, expect, test } from "bun:test";
import { worldMaterializationCommand } from "../src/world-materialization.js";

describe("world cold materialization", () => {
  test("a cold container materializes once under the container-wide lock", () => {
    const command = worldMaterializationCommand({
      worldRoot: "/workspace/world",
      manifestId: "live:manifest-1",
      exportUrl: "https://builder.example/internal/world/export?manifest=one",
      capability: "capability-1",
    });
    const lock = command.indexOf("/usr/bin/flock --exclusive 9");
    const markerCheck = command.indexOf('if [ ! -f "$marker" ]');
    const exportWorld = command.indexOf("curl --fail");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(markerCheck).toBeGreaterThan(lock);
    expect(exportWorld).toBeGreaterThan(markerCheck);
    expect(command).toContain("/workspace/.world-materialize.lock");
    expect(command).toContain("/workspace/world/.stella/world-manifest");
    expect(command).toContain("x-stella-world-revision");
    expect(command).toContain('{"manifestId":"%s","revision":%s}');
    expect(command.match(/curl --fail/gu)).toHaveLength(1);
  });
});
