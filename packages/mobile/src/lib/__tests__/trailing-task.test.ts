import { describe, expect, test } from "bun:test";
import { TrailingTask, type TrailingTaskClock } from "../trailing-task";

const fakeClock = () => {
  let now = 0;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: TrailingTaskClock = {
    setTimeout: (run, ms) => {
      nextHandle += 1;
      timers.set(nextHandle, { at: now + ms, run });
      return nextHandle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance };
};

describe("trailing task", () => {
  // Ratchet: the cloud cache rebuild (full-row + journal-tail serialization
  // and a SQLite rewrite) used to run once per committed journal record. A
  // turn's burst of records must now cost one rebuild, of the latest snapshot.
  test("a burst of schedules runs only the latest task, once", () => {
    const { clock, advance } = fakeClock();
    const task = new TrailingTask(1_500, 10_000, clock);
    const runs: number[] = [];
    for (let record = 1; record <= 40; record += 1) {
      task.schedule(() => runs.push(record));
      advance(100);
    }
    expect(runs).toEqual([]);
    advance(1_500);
    expect(runs).toEqual([40]);
  });

  test("a steady stream still lands by the max delay", () => {
    const { clock, advance } = fakeClock();
    const task = new TrailingTask(1_500, 10_000, clock);
    const runs: number[] = [];
    for (let tick = 1; tick <= 250; tick += 1) {
      task.schedule(() => runs.push(tick));
      advance(100);
    }
    // 25 s of records every 100 ms: flushed at 10 s and 20 s, then pending.
    expect(runs).toEqual([100, 200]);
    advance(1_500);
    expect(runs).toEqual([100, 200, 250]);
  });

  test("flush runs the held task now and cancel drops it", () => {
    const { clock, advance } = fakeClock();
    const task = new TrailingTask(1_500, 10_000, clock);
    const runs: string[] = [];
    task.schedule(() => runs.push("background"));
    task.flush();
    expect(runs).toEqual(["background"]);
    task.flush();
    task.schedule(() => runs.push("dropped"));
    task.cancel();
    advance(20_000);
    expect(runs).toEqual(["background"]);
  });
});
