import { useState } from "react";

export const PREVIEW_VIEWPORT_HEIGHT = 480;
const OVERSCAN = 5;
/** Fixed row geometry keeps work bounded even for wide, ragged input. */
export function usePreviewWindow(count: number, rowHeight: number) {
  const [scrollTop, setScrollTop] = useState(0);
  const height = Math.min(PREVIEW_VIEWPORT_HEIGHT, count * rowHeight);
  const start = Math.max(
    0,
    Math.min(Math.floor(scrollTop / rowHeight) - OVERSCAN, count - 1),
  );
  const end = Math.min(
    count,
    start + Math.ceil(PREVIEW_VIEWPORT_HEIGHT / rowHeight) + OVERSCAN * 2,
  );
  return {
    start,
    end,
    height,
    top: start * rowHeight,
    bottom: (count - end) * rowHeight,
    onScroll: (event: React.UIEvent<HTMLElement>) =>
      setScrollTop(event.currentTarget.scrollTop),
  };
}
