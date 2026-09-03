import { describe, expect, test } from "bun:test";
import { isCloudHandedOff } from "./placed-dispatch";

describe("cloud hand-off of a placed dispatch", () => {
  test("a cloud dispatch with a turn id is handed off", () => {
    expect(
      isCloudHandedOff({ placement: "cloud", cloudTurnId: "turn-1" }),
    ).toBe(true);
  });

  test("a committed cloud dispatch that has not started is still pending", () => {
    expect(isCloudHandedOff({ placement: "cloud" })).toBe(false);
    expect(isCloudHandedOff({ placement: "cloud", cloudTurnId: " " })).toBe(
      false,
    );
  });

  test("a computer dispatch is followed to its own terminal state", () => {
    expect(
      isCloudHandedOff({ placement: "computer", cloudTurnId: undefined }),
    ).toBe(false);
    expect(isCloudHandedOff(null)).toBe(false);
  });
});
