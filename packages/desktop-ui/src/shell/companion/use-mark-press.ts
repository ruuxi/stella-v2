/**
 * Click-or-drag handling for the mark, shared by the mark window and the
 * panel's invisible hit area at the same spot. Both windows carry it because
 * compositors do not agree on which of the two overlapping always-on-top
 * windows ends up on top; whichever receives the pointer must behave the
 * same. A short press toggles the composer; travel past the threshold turns
 * the press into a drag that main follows by moving both windows.
 */
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Pointer travel before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;

type Press = {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  lastX: number;
  lastY: number;
  frame: number | null;
};

export function useMarkPress(onClick?: () => void): {
  dragging: boolean;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  };
} {
  const api = window.electronAPI?.companion;
  const [dragging, setDragging] = useState(false);
  const pressRef = useRef<Press | null>(null);
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  const flushDragMove = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    press.frame = null;
    api?.dragMove({ screenX: press.lastX, screenY: press.lastY });
  }, [api]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false,
      frame: null,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      press.lastX = event.screenX;
      press.lastY = event.screenY;
      if (!press.moved) {
        const dx = press.lastX - press.startX;
        const dy = press.lastY - press.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        press.moved = true;
        setDragging(true);
        api?.dragStart({ screenX: press.startX, screenY: press.startY });
      }
      if (press.frame === null) {
        press.frame = requestAnimationFrame(flushDragMove);
      }
    },
    [api, flushDragMove],
  );

  const endPress = useCallback(
    (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      pressRef.current = null;
      if (press.frame !== null) cancelAnimationFrame(press.frame);
      if (press.moved) {
        api?.dragMove({ screenX: press.lastX, screenY: press.lastY });
        api?.dragEnd();
        setDragging(false);
        return;
      }
      if (cancelled) return;
      onClickRef.current?.();
      api?.toggleExpanded();
    },
    [api],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => endPress(event, false),
    [endPress],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => endPress(event, true),
    [endPress],
  );
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      api?.showContextMenu();
    },
    [api],
  );

  return {
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu,
    },
  };
}
