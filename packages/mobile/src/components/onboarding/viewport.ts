/**
 * Which transcript rows are on screen, so looping demos can pause when the
 * user scrolls away from them. Rows report their layout, the scroll view
 * reports its offset and height, and a row's subscribers re-render only
 * when its visibility flips.
 */
import { createContext, useContext, useSyncExternalStore } from "react";

/** A row counts as visible once this much of it is inside the viewport. */
const VISIBLE_MARGIN = 32;

export type ViewportStore = {
  setLayout: (id: string, y: number, height: number) => void;
  setScroll: (y: number) => void;
  setHeight: (height: number) => void;
  isVisible: (id: string) => boolean;
  subscribe: (listener: () => void) => () => void;
};

export function createViewportStore(): ViewportStore {
  const layouts = new Map<string, { y: number; height: number }>();
  let scrollY = 0;
  let viewportHeight = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    setLayout: (id, y, height) => {
      layouts.set(id, { y, height });
      notify();
    },
    setScroll: (y) => {
      scrollY = y;
      notify();
    },
    setHeight: (height) => {
      viewportHeight = height;
      notify();
    },
    isVisible: (id) => {
      const layout = layouts.get(id);
      // Unmeasured rows are assumed visible: they just mounted at the tail.
      if (!layout || viewportHeight === 0) return true;
      return (
        layout.y + layout.height > scrollY + VISIBLE_MARGIN &&
        layout.y < scrollY + viewportHeight - VISIBLE_MARGIN
      );
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const ViewportContext = createContext<ViewportStore | null>(null);

export function useOnScreen(id: string): boolean {
  const store = useContext(ViewportContext);
  const getSnapshot = () => (store ? store.isVisible(id) : true);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    getSnapshot,
    getSnapshot,
  );
}

const noopSubscribe = () => () => undefined;
