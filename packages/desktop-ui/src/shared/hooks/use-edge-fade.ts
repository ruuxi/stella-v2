import { useEffect, useRef, type RefObject } from "react";

type EdgeFadeAxis = "horizontal" | "vertical";

type EdgeFadeOptions = {

  axis?: EdgeFadeAxis;
};

export function useEdgeFade<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { axis = "horizontal" }: EdgeFadeOptions = {},
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const TOLERANCE = 1;

    const update = () => {
      const max =
        axis === "horizontal"
          ? node.scrollWidth - node.clientWidth
          : node.scrollHeight - node.clientHeight;

      if (max <= TOLERANCE) {
        node.dataset.atStart = "true";
        node.dataset.atEnd = "true";
        return;
      }
      const offset =
        axis === "horizontal" ? node.scrollLeft : node.scrollTop;
      node.dataset.atStart = offset <= TOLERANCE ? "true" : "false";
      node.dataset.atEnd = offset >= max - TOLERANCE ? "true" : "false";
    };

    update();
    requestAnimationFrame(update);

    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) {
      if (child instanceof Element) observer.observe(child);
    }
    const childListObserver = new MutationObserver(() => {
      for (const child of node.children) {
        if (child instanceof Element) observer.observe(child);
      }
      update();
    });
    childListObserver.observe(node, { childList: true });
    window.addEventListener("resize", update);

    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
      childListObserver.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, axis]);
}

export function useEdgeFadeRef<T extends HTMLElement>(
  options?: EdgeFadeOptions,
) {
  const ref = useRef<T | null>(null);
  useEdgeFade(ref, options);
  return ref;
}
