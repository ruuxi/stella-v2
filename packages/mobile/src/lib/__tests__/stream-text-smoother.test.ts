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

describe("stream text smoother buffer", () => {
  test("reveals a long backlog in order and exactly once", async () => {
    // The buffer is consumed through a moving head index with periodic
    // compaction rather than by re-slicing. Guards the off-by-one hazards that
    // introduces: text must come out in order, whole, and without repeats,
    // across enough frames to cross the compaction threshold.
    await withRaf(
      (cb) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
      (handle) =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
      async () => {
        const input = Array.from({ length: 20000 }, (_, i) =>
          String.fromCharCode(97 + (i % 26)),
        ).join("");
        let out = "";
        const smoother = createStreamTextSmoother({
          appendText: (t) => {
            out += t;
          },
        });
        // Push in bursts, as a provider would, so pushes interleave with
        // reveals and the head index advances against a growing array.
        for (let i = 0; i < input.length; i += 250) {
          smoother.push(input.slice(i, i + 250));
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await smoother.drain();
        expect(out).toBe(input);
      },
    );
  });

  test("splits surrogate pairs across frames without corrupting them", async () => {
    await withRaf(
      (cb) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
      (handle) =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
      async () => {
        // Astral-plane glyphs are two code units each; the pacer reveals two
        // code POINTS per frame, so a naive index would tear them.
        const input = "🌊🔥🌱🪐✨🛰️🌗".repeat(40);
        let out = "";
        const smoother = createStreamTextSmoother({
          appendText: (t) => {
            out += t;
          },
        });
        smoother.push(input);
        await smoother.drain();
        expect(out).toBe(input);
        expect(out.includes("�")).toBe(false);
      },
    );
  });
});
