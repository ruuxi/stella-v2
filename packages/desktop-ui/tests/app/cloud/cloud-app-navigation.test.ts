import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import {
  closeCloudAppPanel,
  cloudAppIdFromLocation,
  cloudAppLocation,
  isCloudAppLocation,
  openCloudAppPanel,
} from "@/features/cloud/open-cloud-app-panel";

describe("cloud app sidebar navigation", () => {
  beforeEach(() => sidebarSections.reset());
  afterEach(() => sidebarSections.reset());

  it("namespaces cloud identity away from a colliding local slug", () => {
    sidebarSections.openLocation("apps", "shared");
    openCloudAppPanel({ appId: "shared" });

    const appLocations = sidebarSections
      .getSnapshot()
      .tabs.filter((tab) => tab.kind === "apps")
      .map((tab) => tab.location);
    expect(appLocations).toEqual(["shared", "cloud:shared"]);

    openCloudAppPanel({ appId: "shared" });
    expect(
      sidebarSections
        .getSnapshot()
        .tabs.filter((tab) => tab.location === "cloud:shared"),
    ).toHaveLength(1);

    closeCloudAppPanel("shared");
    expect(
      sidebarSections
        .getSnapshot()
        .tabs.some((tab) => tab.location === "shared"),
    ).toBe(true);
    expect(
      sidebarSections
        .getSnapshot()
        .tabs.some((tab) => tab.location === "cloud:shared"),
    ).toBe(false);
  });

  it("parses only non-empty cloud locations", () => {
    expect(cloudAppLocation("app-1")).toBe("cloud:app-1");
    expect(cloudAppIdFromLocation("cloud:app-1")).toBe("app-1");
    expect(cloudAppIdFromLocation("cloud:   ")).toBeNull();
    expect(cloudAppIdFromLocation("app-1")).toBeNull();
    expect(isCloudAppLocation("cloud:app-1")).toBe(true);
    expect(isCloudAppLocation(null)).toBe(false);
  });
});

