import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  type DisplayTabPayload,
  normalizeDisplayPayload,
} from "@stella/contracts/desktop/display-payload";
import {
  DISPLAY_MAIN_CONTENT_MIN_WIDTH,
  DISPLAY_PANEL_MIN_WIDTH,
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { payloadToTabSpec } from "./display/payload-to-tab-spec";
import { SidebarSectionBody } from "@/shell/sidebar-sections/SidebarSectionBody";
import { useT } from "@/shared/i18n";
import "./right-sidebar.css";
import "./right-sidebar-panel.css";
import "./shell-junction.css";

export interface RightSidebarHandle {

  open(payload: DisplayTabPayload): void;

  update(payload: DisplayTabPayload): void;

  close(): void;
}

type RightSidebarProps = {
  portalTarget?: Element | null;
};

const DISPLAY_PANEL_DEFAULT_WIDTH = 600;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const computeDefaultWidth = (): number => DISPLAY_PANEL_DEFAULT_WIDTH;

const measureShellWidth = (): number => {
  const shell = document.querySelector<HTMLElement>(".full-body");
  return shell?.getBoundingClientRect().width ?? window.innerWidth;
};

const computeMaxWidth = (): number => {
  const available = measureShellWidth() - DISPLAY_MAIN_CONTENT_MIN_WIDTH;
  return Math.max(DISPLAY_PANEL_MIN_WIDTH, Math.floor(available));
};

const resolveDisplayPanelWidth = (preferredWidth: number | null): number => {
  const desired = preferredWidth ?? computeDefaultWidth();
  return clampNumber(
    desired,
    DISPLAY_PANEL_MIN_WIDTH,
    Math.max(DISPLAY_PANEL_MIN_WIDTH, computeMaxWidth()),
  );
};

const DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD = 260;
const DISPLAY_PANEL_WIDTH_CSS_VAR = "--display-panel-width";

const lastAppliedDisplayPanelWidthPx = new WeakMap<HTMLElement, number>();

const applyDisplayPanelWidthCssVar = (width: number | null): void => {
  const root = document.documentElement;
  const nextWidth = Math.round(resolveDisplayPanelWidth(width));
  if (lastAppliedDisplayPanelWidthPx.get(root) === nextWidth) return;
  lastAppliedDisplayPanelWidthPx.set(root, nextWidth);
  root.style.setProperty(DISPLAY_PANEL_WIDTH_CSS_VAR, `${nextWidth}px`);
};

const clearDisplayPanelWidthCssVar = (): void => {
  const root = document.documentElement;
  lastAppliedDisplayPanelWidthPx.delete(root);
  root.style.removeProperty(DISPLAY_PANEL_WIDTH_CSS_VAR);
};

export const RightSidebar = forwardRef<
  RightSidebarHandle,
  RightSidebarProps
>(function RightSidebar({ portalTarget }, ref) {
  const t = useT();
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const asideRef = useRef<HTMLElement | null>(null);

  const shellVisible = panelOpen;

  useImperativeHandle(
    ref,
    () => ({
      open(rawPayload) {
        const next = normalizeDisplayPayload(rawPayload);
        if (!next) return;
        displayTabs.openTab(payloadToTabSpec(next));
      },
      update(rawPayload) {
        const next = normalizeDisplayPayload(rawPayload);
        if (!next) return;
        const spec = payloadToTabSpec(next);
        const { panelOpen } = displayTabs.getSnapshot();

        displayTabs.openTab(
          spec,
          panelOpen
            ? { activate: false }
            : { activate: true, openPanel: false },
        );
      },
      close() {
        displayTabs.setPanelOpen(false);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;

      if (e.defaultPrevented) return;

      if (displayTabs.getSnapshot().panelExpanded) {
        displayTabs.setPanelExpanded(false);
      } else {
        displayTabs.setPanelOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  useLayoutEffect(() => {
    let frame = 0;
    const syncWidthVarNow = () => {
      frame = 0;
      applyDisplayPanelWidthCssVar(displayTabs.getLayoutSnapshot().panelWidth);
    };

    const scheduleWidthVarSync = () => {

      if (!displayTabs.getLayoutSnapshot().panelOpen) return;
      if (frame !== 0) return;
      frame = requestAnimationFrame(syncWidthVarNow);
    };

    const syncOnLayoutChange = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      syncWidthVarNow();
    };

    syncWidthVarNow();
    const unsubscribe = displayTabs.subscribeLayout(syncOnLayoutChange);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleWidthVarSync);
    const shell = document.querySelector<HTMLElement>(".full-body");
    if (shell) resizeObserver?.observe(shell);
    window.addEventListener("resize", scheduleWidthVarSync);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleWidthVarSync);
      clearDisplayPanelWidthCssVar();
    };
  }, []);

  const isFirstExpandedSync = useRef(true);
  useEffect(() => {
    if (isFirstExpandedSync.current) {
      isFirstExpandedSync.current = false;
      return;
    }
    document.body.dataset.displayExpanding = "true";
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        delete document.body.dataset.displayExpanding;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      delete document.body.dataset.displayExpanding;
    };
  }, [panelExpanded]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {

      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const aside = asideRef.current;
      const measuredStartWidth =
        aside?.getBoundingClientRect().width ??
        displayTabs.getSnapshot().panelWidth ??
        0;
      const startX = event.clientX;
      const pointerId = event.pointerId;
      const handle = event.currentTarget;

      const maxWidth = computeMaxWidth();
      const startWidth = panelExpanded ? maxWidth : measuredStartWidth;

      let latestWidth: number | null = null;
      let frame = 0;
      let snappedToExpanded = panelExpanded;
      let collapsedFromExpanded = false;

      const applyLatestWidth = () => {
        frame = 0;
        if (latestWidth == null) return;
        applyDisplayPanelWidthCssVar(latestWidth);
      };

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      aside?.classList.add("right-sidebar--resizing");

      document.body.dataset.displayResizing = "true";

      const onMove = (ev: PointerEvent) => {
        if (collapsedFromExpanded) return;

        const delta = startX - ev.clientX;
        const rawWidth = startWidth + delta;

        if (snappedToExpanded) {
          if (delta > -DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD) return;
          snappedToExpanded = false;
          collapsedFromExpanded = true;
          latestWidth = maxWidth;
          applyDisplayPanelWidthCssVar(maxWidth);
          displayTabs.setPanelWidth(maxWidth);
          displayTabs.setPanelExpanded(false);
          return;
        }

        if (rawWidth >= maxWidth + DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD) {
          snappedToExpanded = true;
          latestWidth = maxWidth;
          if (frame !== 0) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          applyDisplayPanelWidthCssVar(maxWidth);
          displayTabs.setPanelWidth(maxWidth);
          displayTabs.setPanelExpanded(true);
          return;
        }

        latestWidth = Math.max(
          DISPLAY_PANEL_MIN_WIDTH,
          Math.min(maxWidth, rawWidth),
        );
        if (frame === 0) {
          frame = requestAnimationFrame(applyLatestWidth);
        }
      };

      const onUp = () => {
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          applyLatestWidth();
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        aside?.classList.remove("right-sidebar--resizing");
        delete document.body.dataset.displayResizing;
        if (latestWidth != null) {
          displayTabs.setPanelWidth(latestWidth);
        }

        displayTabs.flushPersistedWidth();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [panelExpanded],
  );

  const handleResizeDoubleClick = useCallback(() => {

    displayTabs.setPanelWidth(null);
  }, []);

  const resolvedPortalTarget =
    portalTarget ?? document.querySelector(".full-body") ?? document.body;

  return createPortal(
    <aside
      ref={asideRef}
      className={`right-sidebar right-sidebar-panel${
        shellVisible ? " right-sidebar--shell-visible" : ""
      }${panelOpen ? " right-sidebar--open" : ""}${
        panelOpen && panelExpanded ? " right-sidebar--expanded" : ""
      }`}
      aria-label={t("shell.rightSidebar.workspace")}
      aria-hidden={!shellVisible}
    >
      {panelOpen ? (
        <div
          className="right-sidebar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("shell.rightSidebar.resize")}
          onPointerDown={handleResizeStart}
          onDoubleClick={handleResizeDoubleClick}
          title={t("shell.rightSidebar.resizeHint")}
        />
      ) : null}
      <div className="right-sidebar-inner right-sidebar-panel__frame">
        {

}
        <div className="right-sidebar-panel__body">
          <div
            className={`right-sidebar__active${
              panelOpen ? "" : " right-sidebar__active--kept"
            }`}
          >
            <SidebarSectionBody />
          </div>
        </div>
      </div>
    </aside>,
    resolvedPortalTarget,
  );
});
