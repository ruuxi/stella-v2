import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

const FROZEN_ATTRIBUTE = "data-tabs-frozen";
const FROZEN_WIDTH_PROPERTY = "--tab-frozen-width";
const IDLE_RELEASE_MS = 2000;
const SLIDE_MS = 110;
const RESIZE_MS = 180;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

type PendingClose = {
  closedId: string;
  slideFromId: string | null;
  slideBy: number;
  stripWidth: number;
};

type FreezeState = {
  frozen: boolean;
  naturalMax: number;
  pending: PendingClose | null;
  ids: readonly string[];
  zoneWidth: number;
  lastActivity: number;
  idleTimer: number | null;
  observer: ResizeObserver | null;
  animations: Animation[];
  detach: (() => void) | null;
};

type Options = {
  stripRef: RefObject<HTMLElement | null>;
  zoneRef?: RefObject<HTMLElement | null>;
  tabSelector: string;
  tabIds: readonly string[];
};

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const naturalMaxWidth = (tab: HTMLElement) => {
  const style = getComputedStyle(tab);
  const limits = [style.maxWidth, style.flexBasis]
    .filter((value) => value.endsWith("px"))
    .map((value) => parseFloat(value));
  return limits.length > 0 ? Math.min(...limits) : Infinity;
};

export function useTabStripCloseFreeze({
  stripRef,
  zoneRef,
  tabSelector,
  tabIds,
}: Options) {
  const stateRef = useRef<FreezeState>({
    frozen: false,
    naturalMax: Infinity,
    pending: null,
    ids: tabIds,
    zoneWidth: 0,
    lastActivity: 0,
    idleTimer: null,
    observer: null,
    animations: [],
    detach: null,
  });

  const tabElements = useCallback((): HTMLElement[] => {
    const strip = stripRef.current;
    if (!strip) return [];
    return Array.from(strip.querySelectorAll<HTMLElement>(tabSelector));
  }, [stripRef, tabSelector]);

  const settleAnimations = useCallback(() => {
    const state = stateRef.current;
    for (const animation of state.animations) animation.finish();
    state.animations = [];
  }, []);

  const track = useCallback((animation: Animation) => {
    const state = stateRef.current;
    state.animations.push(animation);
    animation.addEventListener("finish", () => {
      state.animations = state.animations.filter((a) => a !== animation);
    });
  }, []);

  const release = useCallback(
    (animate: boolean) => {
      const state = stateRef.current;
      state.pending = null;
      state.detach?.();
      state.detach = null;
      if (!state.frozen) return;
      state.frozen = false;
      const strip = stripRef.current;
      if (!strip) return;
      settleAnimations();
      const frozenWidth = parseFloat(
        strip.style.getPropertyValue(FROZEN_WIDTH_PROPERTY),
      );
      strip.removeAttribute(FROZEN_ATTRIBUTE);
      strip.style.removeProperty(FROZEN_WIDTH_PROPERTY);
      if (!animate || !Number.isFinite(frozenWidth) || prefersReducedMotion()) {
        return;
      }
      const tabs = tabElements();
      const targets = tabs.map((tab) => tab.getBoundingClientRect().width);
      tabs.forEach((tab, index) => {
        const target = targets[index]!;
        if (Math.abs(target - frozenWidth) < 0.5) return;
        const frame = (width: number) => ({
          flexBasis: `${width}px`,
          flexShrink: 0,
          width: `${width}px`,
          minWidth: `${width}px`,
          maxWidth: `${width}px`,
        });
        track(
          tab.animate([frame(frozenWidth), frame(target)], {
            duration: RESIZE_MS,
            easing: EASING,
          }),
        );
      });
    },
    [settleAnimations, stripRef, tabElements, track],
  );

  const attach = useCallback(() => {
    const state = stateRef.current;
    if (state.detach) return;
    const zone = zoneRef?.current ?? stripRef.current;
    if (!zone) return;

    const onLeave = () => release(true);
    const onMove = () => {
      state.lastActivity = performance.now();
    };
    const checkIdle = () => {
      const idleFor = performance.now() - state.lastActivity;
      if (idleFor >= IDLE_RELEASE_MS) {
        state.idleTimer = null;
        release(true);
        return;
      }
      state.idleTimer = window.setTimeout(checkIdle, IDLE_RELEASE_MS - idleFor);
    };

    zone.addEventListener("pointerleave", onLeave);
    zone.addEventListener("pointermove", onMove, { passive: true });
    state.zoneWidth = zone.getBoundingClientRect().width;
    state.observer = new ResizeObserver((entries) => {
      const width = entries[0]?.borderBoxSize[0]?.inlineSize ?? state.zoneWidth;
      if (Math.abs(width - state.zoneWidth) < 0.5) return;
      release(false);
    });
    state.observer.observe(zone, { box: "border-box" });
    state.idleTimer = window.setTimeout(checkIdle, IDLE_RELEASE_MS);

    state.detach = () => {
      zone.removeEventListener("pointerleave", onLeave);
      zone.removeEventListener("pointermove", onMove);
      state.observer?.disconnect();
      state.observer = null;
      if (state.idleTimer !== null) window.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    };
  }, [release, stripRef, zoneRef]);

  const onTabCloseClick = useCallback(
    (event: ReactMouseEvent, tabId: string) => {
      const state = stateRef.current;
      if (event.detail === 0) {
        release(false);
        return;
      }
      const strip = stripRef.current;
      if (!strip) return;
      settleAnimations();

      const tabs = tabElements();
      const index = tabs.findIndex((tab) => tab.dataset.tabId === tabId);
      if (index === -1 || tabs.length < 2) {
        release(false);
        return;
      }

      const rects = tabs.map((tab) => tab.getBoundingClientRect());
      const overflowing = strip.scrollWidth > strip.clientWidth + 0.5;
      const stripWidth = strip.getBoundingClientRect().width;
      const closed = rects[index]!;
      const isLast = index === tabs.length - 1;
      const spacing = rects[1]!.left - rects[0]!.right;
      if (!state.frozen) state.naturalMax = naturalMaxWidth(tabs[0]!);

      const contentLeft = rects[0]!.left + strip.scrollLeft;
      const fillWidth =
        (closed.right - contentLeft - (tabs.length - 2) * spacing) /
        (tabs.length - 1);
      const frozenWidth = isLast
        ? Math.min(Math.max(fillWidth, closed.width), state.naturalMax)
        : closed.width;

      strip.style.setProperty(FROZEN_WIDTH_PROPERTY, `${frozenWidth}px`);
      strip.setAttribute(FROZEN_ATTRIBUTE, "");
      state.frozen = true;
      state.lastActivity = performance.now();
      const slides = !isLast && !overflowing;
      state.pending = {
        closedId: tabId,
        slideFromId: slides ? (tabs[index + 1]!.dataset.tabId ?? null) : null,
        slideBy: slides ? rects[index + 1]!.left - closed.left : 0,
        stripWidth,
      };
      attach();
    },
    [attach, release, settleAnimations, stripRef, tabElements],
  );

  useLayoutEffect(() => {
    const state = stateRef.current;
    const previous = state.ids;
    state.ids = tabIds;
    if (!state.frozen) return;

    const previousSet = new Set(previous);
    const added = tabIds.some((id) => !previousSet.has(id));
    const nextSet = new Set(tabIds);
    const removed = previous.filter((id) => !nextSet.has(id));
    if (added || tabIds.length === 0) {
      release(true);
      return;
    }
    if (removed.length === 0) return;

    const pending = state.pending;
    if (!pending || removed.length !== 1 || removed[0] !== pending.closedId) {
      release(true);
      return;
    }
    state.pending = null;
    const strip = stripRef.current;
    if (
      !strip ||
      pending.slideFromId === null ||
      pending.slideBy <= 0 ||
      prefersReducedMotion()
    ) {
      return;
    }
    const timing = { duration: SLIDE_MS, easing: EASING };
    let sliding = false;
    for (const child of Array.from(strip.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (!sliding && child.dataset.tabId !== pending.slideFromId) continue;
      sliding = true;
      track(
        child.animate(
          [
            { transform: `translateX(${pending.slideBy}px)` },
            { transform: "translateX(0)" },
          ],
          timing,
        ),
      );
    }
    if (!sliding) return;
    track(
      strip.animate(
        [
          { minWidth: `${pending.stripWidth}px` },
          { minWidth: `${pending.stripWidth - pending.slideBy}px` },
        ],
        timing,
      ),
    );
  }, [release, stripRef, tabIds, track]);

  useEffect(
    () => () => {
      const state = stateRef.current;
      state.detach?.();
      state.detach = null;
      for (const animation of state.animations) animation.cancel();
      state.animations = [];
    },
    [],
  );

  return { onTabCloseClick };
}
