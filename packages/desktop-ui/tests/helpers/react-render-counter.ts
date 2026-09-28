/**
 * Deterministic per-commit component render counter for jsdom perf ratchets.
 *
 * Installs a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` so React reports every
 * committed root, then walks the committed tree the way React DevTools'
 * profiler does: a subtree whose child pointer is unchanged was bailed out
 * wholesale and is skipped; a component fiber counts as rendered when it is
 * new (mount) or carries the `PerformedWork` flag (its function body ran).
 *
 * MUST be imported before `react-dom` is first evaluated — make it the first
 * import of the test file.
 */

type Fiber = {
  tag: number;
  type: unknown;
  elementType: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
};

type FiberRoot = { current: Fiber };

const PERFORMED_WORK = 0b1;
// FunctionComponent, ClassComponent, ForwardRef, SimpleMemoComponent. A
// MemoComponent (14) wraps a child fiber that does the rendering, so it is
// skipped to avoid double counting.
const COMPONENT_TAGS = new Set([0, 1, 11, 15]);

const componentName = (fiber: Fiber): string => {
  const pick = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === "function") {
      const fn = value as { displayName?: string; name?: string };
      return fn.displayName || fn.name || null;
    }
    if (typeof value === "object") {
      const obj = value as {
        displayName?: string;
        render?: unknown;
        type?: unknown;
      };
      return obj.displayName || pick(obj.render) || pick(obj.type);
    }
    return null;
  };
  return pick(fiber.type) ?? pick(fiber.elementType) ?? "Anonymous";
};

let recording = false;
let counts = new Map<string, number>();
let commits = 0;

const record = (fiber: Fiber) => {
  const name = componentName(fiber);
  counts.set(name, (counts.get(name) ?? 0) + 1);
};

const walk = (next: Fiber, prev: Fiber | null) => {
  if (COMPONENT_TAGS.has(next.tag)) {
    if (!prev || (next.flags & PERFORMED_WORK) !== 0) record(next);
  }
  if (prev && next.child === prev.child) return;
  for (let child = next.child; child; child = child.sibling) {
    walk(child, child.alternate);
  }
};

const hook = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onScheduleFiberRoot: () => {},
  onCommitFiberUnmount: () => {},
  onPostCommitFiberRoot: () => {},
  onCommitFiberRoot: (_id: unknown, root: FiberRoot) => {
    if (!recording) return;
    commits += 1;
    const current = root.current;
    walk(current, current.alternate);
  },
  checkDCE: () => {},
};

(globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
  .__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

export type RenderReport = {
  commits: number;
  total: number;
  byComponent: Record<string, number>;
};

/**
 * Runs `action` (sync or async, typically wrapped in `act`) and reports how
 * many component renders React committed while it ran.
 */
export const countRenders = async (
  action: () => unknown | Promise<unknown>,
): Promise<RenderReport> => {
  counts = new Map();
  commits = 0;
  recording = true;
  try {
    await action();
  } finally {
    recording = false;
  }
  const byComponent = Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]),
  );
  let total = 0;
  for (const value of counts.values()) total += value;
  return { commits, total, byComponent };
};
