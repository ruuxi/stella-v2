import { describe, expect, test } from "bun:test";
import {
  getWorkingIndicatorCharacterState,
  pickWorkingIndicatorToolPose,
  WORKING_INDICATOR_TOOL_POSES,
} from "../working-indicator-character";

describe("working indicator character state", () => {
  test("keeps the bouncing ellipsis for thinking without a tool", () => {
    expect(getWorkingIndicatorCharacterState()).toBe("thinking");
    expect(getWorkingIndicatorCharacterState("  ")).toBe("thinking");
  });

  test("matches desktop tool families to character poses", () => {
    expect(getWorkingIndicatorCharacterState("web_search")).toBe("searching");
    expect(getWorkingIndicatorCharacterState("fetch_url")).toBe("reading");
    expect(getWorkingIndicatorCharacterState("read_file")).toBe("reading");
    expect(getWorkingIndicatorCharacterState("write_file")).toBe("writing");
    expect(getWorkingIndicatorCharacterState("apply_patch")).toBe("working");
    expect(getWorkingIndicatorCharacterState("edit_file")).toBe("writing");
    expect(getWorkingIndicatorCharacterState("exec_command")).toBe("working");
  });

  test("a seeded pose comes from the whole repertoire and never repeats the last one", () => {
    const seen = new Set<string>();
    for (let call = 0; call < 40; call += 1) {
      seen.add(getWorkingIndicatorCharacterState("code", `call-${call}:0`));
    }
    expect([...seen].sort()).toEqual([...WORKING_INDICATOR_TOOL_POSES].sort());
    expect(getWorkingIndicatorCharacterState("code", "stable:0")).toBe(
      getWorkingIndicatorCharacterState("code", "stable:0"),
    );
    for (const previous of WORKING_INDICATOR_TOOL_POSES) {
      for (let epoch = 0; epoch < 20; epoch += 1) {
        expect(pickWorkingIndicatorToolPose(`seed:${epoch}`, previous)).not.toBe(previous);
      }
    }
    expect(getWorkingIndicatorCharacterState(undefined, "seed:0")).toBe("thinking");
  });
});
