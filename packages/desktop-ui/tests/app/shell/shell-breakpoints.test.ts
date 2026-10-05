import { describe, expect, it } from "vitest";
import { getShellBreakpointState } from "@/shell/shell-breakpoints";

// The left sidebar is gone and so is the standalone activity surface, so the
// one remaining threshold is a plain width comparison.
describe("shell breakpoints", () => {
  it("gives the display panel the whole shell at 720 and below", () => {
    expect(getShellBreakpointState(721).displayPanelTakeover).toBe(false);
    expect(getShellBreakpointState(720)).toMatchObject({
      displayPanelTakeover: true,
    });
  });

  it("treats an unmeasured shell as wide, not as the narrowest layout", () => {
    // Width 0 is "no measurement yet" (pre-ResizeObserver). Collapsing then
    // would flash the takeover layout on every cold start.
    expect(getShellBreakpointState(0)).toMatchObject({
      displayPanelTakeover: false,
    });
  });
});
