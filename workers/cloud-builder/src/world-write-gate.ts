/**
 * Orders a resident turn's two kinds of world writer.
 *
 * A call into the attached container pulls the world before it runs and
 * pushes the disk's listing after, and that push deletes whatever the world
 * holds that the disk does not. A change this Durable Object commits to the
 * world directly (a `code` cell's `fs` write, the worker shell, a DO-local
 * Write before the container attached) must therefore never land between a
 * container call's pull and its push, or the push silently undoes it.
 *
 * Container calls share the gate with each other, so parallel calls still run
 * in parallel. A direct commit waits for every running container call to
 * finish and holds new ones back until it has landed, so the next call's pull
 * brings it down to the disk.
 */

export type WorldWriteGate = Readonly<{
  /** A container call: concurrent with other container calls. */
  shared<T>(work: () => Promise<T>): Promise<T>;
  /** A direct world commit: alone, and ahead of container calls waiting. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}>;

export const createWorldWriteGate = (): WorldWriteGate => {
  let running = 0;
  let writing = false;
  const readers: Array<() => void> = [];
  const writers: Array<() => void> = [];
  const wake = (): void => {
    if (writing) return;
    if (writers.length > 0) {
      if (running === 0) {
        writing = true;
        writers.shift()!();
      }
      return;
    }
    while (readers.length > 0) {
      running += 1;
      readers.shift()!();
    }
  };
  return {
    async shared(work) {
      if (writing || writers.length > 0) {
        await new Promise<void>((resolve) => readers.push(resolve));
      } else {
        running += 1;
      }
      try {
        return await work();
      } finally {
        running -= 1;
        wake();
      }
    },
    async exclusive(work) {
      if (writing || running > 0 || writers.length > 0) {
        await new Promise<void>((resolve) => writers.push(resolve));
      } else {
        writing = true;
      }
      try {
        return await work();
      } finally {
        writing = false;
        wake();
      }
    },
  };
};
