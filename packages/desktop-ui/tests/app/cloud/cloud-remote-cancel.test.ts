import { describe, expect, test } from "vitest";
import { advanceOwnDeviceTurnPhases } from "../../../src/features/cloud/cloud-remote-cancel";

const ownPrefix = "desktop:device-1:";

describe("advanceOwnDeviceTurnPhases", () => {
  test("does not treat historical canceled rows as a new remote stop", () => {
    const result = advanceOwnDeviceTurnPhases(
      new Map(),
      [{ turnId: `${ownPrefix}old`, phase: "canceled" }],
      ownPrefix,
    );

    expect(result.canceledTurnIds).toEqual([]);
    expect(result.phases.get(`${ownPrefix}old`)).toBe("canceled");
  });

  test("reports an own-device started to canceled transition once", () => {
    const started = advanceOwnDeviceTurnPhases(
      new Map(),
      [{ turnId: `${ownPrefix}active`, phase: "started" }],
      ownPrefix,
    );
    const canceled = advanceOwnDeviceTurnPhases(
      started.phases,
      [{ turnId: `${ownPrefix}active`, phase: "canceled" }],
      ownPrefix,
    );
    const repeated = advanceOwnDeviceTurnPhases(
      canceled.phases,
      [{ turnId: `${ownPrefix}active`, phase: "canceled" }],
      ownPrefix,
    );

    expect(canceled.canceledTurnIds).toEqual([`${ownPrefix}active`]);
    expect(repeated.canceledTurnIds).toEqual([]);
  });

  test("ignores turns launched by another desktop", () => {
    const result = advanceOwnDeviceTurnPhases(
      new Map([["desktop:device-2:active", "started"]]),
      [{ turnId: "desktop:device-2:active", phase: "canceled" }],
      ownPrefix,
    );

    expect(result.canceledTurnIds).toEqual([]);
  });
});
