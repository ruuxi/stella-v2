import { describe, expect, it } from "vitest";
import {
  computeStatus,
  normalizeDisplayStatusText,
} from "@/features/chat/status-utils";
import { getWorkingIndicatorDisplayStatus } from "@/features/chat/working-indicator-state";

const EXEC_COMMAND_RESULT_JSON = `{
  "session_id": null,
  "running": false,
  "exit_code": 127,
  "output": "",
  "wall_time_seconds": 45.209,
  "original_token_count": 0,
  "cwd": "C:\\\\Users\\\\user\\\\AppData\\\\Local\\\\Programs\\\\Stella\\\\resources",
  "command": "wsl -e bash -lc \\"nvcc --version\\""
}`;

describe("normalizeDisplayStatusText", () => {
  it("maps verb-prefixed runtime tool names to friendly copy", () => {
    expect(normalizeDisplayStatusText("Running Web")).toBe("Searching");
    expect(normalizeDisplayStatusText("Running exec_command")).toBe(
      computeStatus({ toolName: "exec_command", seed: "" }),
    );
    expect(normalizeDisplayStatusText("Running node_repl")).toBe(
      computeStatus({ toolName: "node_repl", seed: "" }),
    );
  });

  it("maps a leaked exec_command session payload to friendly command copy", () => {
    expect(normalizeDisplayStatusText(EXEC_COMMAND_RESULT_JSON)).toBe(
      "Command failed",
    );
    expect(
      getWorkingIndicatorDisplayStatus({
        status: EXEC_COMMAND_RESULT_JSON,
      }),
    ).toBe("Command failed");
    expect(
      getWorkingIndicatorDisplayStatus({
        status: EXEC_COMMAND_RESULT_JSON.replace(/\s+/g, " ").trim(),
      }),
    ).toBe("Command failed");
  });

  it("never renders unknown machine-looking status text raw", () => {
    expect(normalizeDisplayStatusText("custom__json_x_y_z")).toBe(
      computeStatus({ toolName: "unknown", seed: "custom__json_x_y_z" }),
    );
    expect(normalizeDisplayStatusText("{ not json")).toBe(
      computeStatus({ toolName: "unknown", seed: "{ not json" }),
    );
    expect(
      normalizeDisplayStatusText("Running exec_command with internal details"),
    ).toBe(computeStatus({ toolName: "exec_command", seed: "" }));
  });

  it("leaves genuine human-readable status text untouched", () => {
    expect(normalizeDisplayStatusText("Compacting context")).toBe(
      "Compacting context",
    );
    expect(normalizeDisplayStatusText("Checking connector")).toBe(
      "Checking connector",
    );
  });
});
