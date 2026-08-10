import { describe, expect, it } from "vitest";
import {
  activityRowKey,
  compareActivityRowsByLifecycleStart,
  type ActivityRow,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

const task = (
  id: string,
  startedAtMs: number,
  overrides: Partial<TaskItem> = {},
): ActivityRow => ({
  kind: "task",
  task: {
    id,
    description: id,
    agentType: "general",
    source: "local",
    readOnly: false,
    status: "running",
    statusText: undefined,
    startedAtMs,
    completedAtMs: undefined,
    lastUpdatedAtMs: startedAtMs,
    ...overrides,
  },
});

describe("Activity lifecycle ordering", () => {
  const orderedKeys = (rows: readonly ActivityRow[]) =>
    [...rows].sort(compareActivityRowsByLifecycleStart).map(activityRowKey);

  it("survives hundreds of status, reasoning, and tool updates plus refetch reorder", () => {
    const starts = { alpha: 100, beta: 200, gamma: 300 } as const;
    const expected = ["task:gamma", "task:beta", "task:alpha"];

    for (let update = 0; update < 300; update += 1) {
      const ids = (["alpha", "beta", "gamma"] as const).slice();
      ids.sort((a, b) =>
        update % 2 === 0 ? a.localeCompare(b) : b.localeCompare(a),
      );
      const refetched = ids.map((id, index) =>
        task(id, starts[id], {
          lastUpdatedAtMs: 1_000 + update * 10 + index,
          statusText: `Update ${update}`,
          reasoningText: `Reasoning ${update}`,
          toolActivity: {
            toolCallId: `call-${update}`,
            toolName: "Node Repl",
            label: "Running Node Repl",
            state: update % 2 === 0 ? "started" : "completed",
          },
        }),
      );

      // Each iteration recreates every object and ordering state, modeling a
      // full refetch/remount rather than relying on component-local memory.
      expect(orderedKeys(refetched)).toEqual(expected);
    }
  });

  it("uses a stable key tie breaker and moves rows only between lifecycle groups", () => {
    const alpha = task("alpha", 100);
    const beta = task("beta", 100);
    const gamma = task("gamma", 300);
    expect(orderedKeys([beta, gamma, alpha])).toEqual([
      "task:gamma",
      "task:alpha",
      "task:beta",
    ]);

    const completedGamma = task("gamma", 300, {
      status: "completed",
      completedAtMs: 500,
    });
    const rows = [beta, completedGamma, alpha];
    expect(
      orderedKeys(
        rows.filter(
          (row) => row.kind === "task" && row.task.status === "running",
        ),
      ),
    ).toEqual(["task:alpha", "task:beta"]);
    expect(
      rows.filter(
        (row) => row.kind === "task" && row.task.status !== "running",
      ),
    ).toEqual([completedGamma]);
  });
});
