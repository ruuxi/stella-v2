// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  PANEL_SIDEBAR_SECTIONS,
  SIDEBAR_SECTIONS,
} from "@/features/workspace-display/sidebar-sections";
import { SIDEBAR_SECTION_META } from "@/shell/sidebar-sections/SidebarTabRail";

describe("browser sidebar registration", () => {
  it("registers Browser as a panel section with rail metadata", () => {
    expect(SIDEBAR_SECTIONS).toContain("browser");
    expect(PANEL_SIDEBAR_SECTIONS).toContain("browser");
    expect(SIDEBAR_SECTION_META.browser.label).toBe("Browser");
  });
});
