import { describe, expect, test } from "bun:test";
import { createStreamTextSmoother } from "../stream-text-smoother";

type RafGlobals = {
  requestAnimationFrame?: unknown;
  cancelAnimationFrame?: unknown;
};

const withRaf = async (
  raf: (cb: (t: number) => void) => number,
  caf: (handle: number) => void,
  run: () => Promise<void>,
) => {
  const g = globalThis as unknown as RafGlobals;
  const original = {
    raf: g.requestAnimationFrame,
    caf: g.cancelAnimationFrame,
  };
  g.requestAnimationFrame = raf;
  g.cancelAnimationFrame = caf;
  try {
    await run();
  } finally {
    g.requestAnimationFrame = original.raf;
    g.cancelAnimationFrame = original.caf;
  }
};

describe("stream text smoother drain", () => {
  test("drain still resolves and flushes the buffer when rAF is starved", async () => {
    // A frame loop that never fires — models a backgrounded tab / idle Fabric
    // loop. Without the safety timer the drain promise (and the turn that
    // awaits it before clearing `sending`) would hang forever.
    await withRaf(
      () => 1,
      () => {},
      async () => {
        let out = "";
        const smoother = createStreamTextSmoother({
          appendText: (t) => {
            out += t;
          },
        });
        smoother.push("hello world");
        const start = Date.now();
        await smoother.drain();
        expect(out).toBe("hello world");
        // Settled via the safety flush, not an unbounded hang.
        expect(Date.now() - start < 3000).toBe(true);
      },
    );
  });

  test("drain resolves promptly and reveals text when rAF is healthy", async () => {
    await withRaf(
      (cb) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
      (handle) =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
      async () => {
        let out = "";
        const smoother = createStreamTextSmoother({
          appendText: (t) => {
            out += t;
          },
        });
        smoother.push("abcdef");
        const start = Date.now();
        await smoother.drain();
        expect(out).toBe("abcdef");
        expect(Date.now() - start < 1000).toBe(true);
      },
    );
  });
});
