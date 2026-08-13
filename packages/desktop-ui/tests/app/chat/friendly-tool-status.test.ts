import { describe, expect, it } from "vitest";
import { friendlyInlineToolStatus } from "@/features/chat/lib/friendly-tool-status";

const activity = (
  toolName: string,
  state: "started" | "completed",
  exitCode?: number,
) => ({
  toolCallId: "call-1",
  toolName,
  label: toolName,
  state,
  ...(exitCode === undefined ? {} : { exitCode }),
});

describe("friendlyInlineToolStatus", () => {
  it("uses state-aware friendly labels for common tools", () => {
    expect(friendlyInlineToolStatus(activity("exec_command", "started"))).toBe(
      "Running command",
    );
    expect(
      friendlyInlineToolStatus(activity("exec_command", "completed", 0)),
    ).toBe("Ran command");
    expect(friendlyInlineToolStatus(activity("Edit", "completed"))).toBe(
      "Edited files",
    );
    expect(friendlyInlineToolStatus(activity("Read", "started"))).toBe(
      "Reading files",
    );
  });

  it("turns non-zero command exits into a friendly failure", () => {
    expect(
      friendlyInlineToolStatus(activity("exec_command", "completed", 2)),
    ).toBe("Command failed");
  });

  it("keeps agent lifecycle tools out of raw inline status copy", () => {
    expect(friendlyInlineToolStatus(activity("spawn_agent", "started"))).toBe(
      "Starting work",
    );
    expect(friendlyInlineToolStatus(activity("send_input", "completed"))).toBe(
      "Updated work",
    );
    expect(friendlyInlineToolStatus(activity("pause_agent", "started"))).toBe(
      "Pausing work",
    );
  });

  it("does not expose unknown or namespaced tool names", () => {
    expect(
      friendlyInlineToolStatus(activity("custom__json_x_y_z", "started")),
    ).toBe("Working on it");
    expect(
      friendlyInlineToolStatus(activity("custom__json_x_y_z", "completed")),
    ).toBe("Finished a step");
  });
});
