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
  test("reveals live text before completion when rAF is starved", async () => {
    await withRaf(
      () => 1,
      () => {},
      async () => {
        const input = "abcdefghijklmnopqrstuvwxyz";
        let out = "";
        let resolveFirstAppend = () => {};
        const firstAppend = new Promise<void>((resolve) => {
          resolveFirstAppend = resolve;
        });
        const smoother = createStreamTextSmoother({
          appendText: (text) => {
            out += text;
            resolveFirstAppend();
          },
        });

        smoother.push(input);
        const revealedBeforeCompletion = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 500);
          void firstAppend.then(() => {
            clearTimeout(timeout);
            resolve(true);
          });
        });

        expect(revealedBeforeCompletion).toBe(true);
        expect(out.length).toBeGreaterThan(0);
        expect(out.length < input.length).toBe(true);
        smoother.cancel();
      },
    );
  });

  test("drain still resolves and flushes the buffer when rAF is starved", async () => {
    // A frame loop that never fires — models a backgrounded tab / idle Fabric
    // loop. The timer fallback must still empty the buffer and resolve drain.
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
        // Settled via paced fallback ticks, not an unbounded hang.
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
