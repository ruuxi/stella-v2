import { describe, expect, it } from "vitest";
import { getShellBreakpointState } from "@/shell/shell-breakpoints";

describe("shell breakpoints", () => {
  it("auto-hides the workspace strip at 1120 and below", () => {
    expect(getShellBreakpointState(1121)).toMatchObject({
      hideWorkspaceStrip: false,
      displayPanelTakeover: false,
    });
    expect(getShellBreakpointState(1120)).toMatchObject({
      hideWorkspaceStrip: true,
      displayPanelTakeover: false,
    });
  });

  it("gives the display panel the whole shell at 720 and below", () => {
    expect(getShellBreakpointState(721).displayPanelTakeover).toBe(false);
    expect(getShellBreakpointState(720)).toMatchObject({
      hideWorkspaceStrip: true,
      displayPanelTakeover: true,
    });
  });

  it("treats an unmeasured shell as wide, not as the narrowest layout", () => {

    expect(getShellBreakpointState(0)).toMatchObject({
      hideWorkspaceStrip: false,
      displayPanelTakeover: false,
    });
  });
});
