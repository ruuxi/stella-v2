import { describe, expect, it } from "vitest";
import {
  cloudWorldDriveName,
  cloudWorldDrivePath,
} from "@stella/contracts/cloud-world-paths";

describe("cloudWorldDrivePath", () => {
  it("maps world-absolute drive links to drive-relative paths", () => {
    expect(cloudWorldDrivePath("/workspace/world/drive/notes.md")).toBe("notes.md");
    expect(cloudWorldDrivePath("/workspace/world/drive/reports/q3/a.pdf")).toBe(
      "reports/q3/a.pdf",
    );
    expect(cloudWorldDrivePath("/workspace/forks/f1/world/drive/x.csv")).toBe("x.csv");
  });

  it("ignores everything that is not a drive file", () => {
    expect(cloudWorldDrivePath("/workspace/world/notes.md")).toBeNull();
    expect(cloudWorldDrivePath("/workspace/world/drive/")).toBeNull();
    expect(cloudWorldDrivePath("/workspace/world/drive/../secret")).toBeNull();
    expect(cloudWorldDrivePath("/workspace/world/drive/.stella/state")).toBeNull();
    expect(cloudWorldDrivePath("/Users/sam/notes.md")).toBeNull();
    expect(cloudWorldDrivePath("C:/workspace/world/drive/a.md")).toBeNull();
  });

  it("names a drive path by its last segment", () => {
    expect(cloudWorldDriveName("reports/q3/a.pdf")).toBe("a.pdf");
    expect(cloudWorldDriveName("a.pdf")).toBe("a.pdf");
  });
});
