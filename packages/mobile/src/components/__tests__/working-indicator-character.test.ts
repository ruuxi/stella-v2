import { describe, expect, test } from "bun:test";
import { getWorkingIndicatorCharacterState } from "../working-indicator-character";

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
});
