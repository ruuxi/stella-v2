import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
} from "react";
import { RegionCapture } from "./RegionCapture";
import "./overlays.css";

/**
 * OverlayRoot manages the unified transparent overlay window.
 *
 * All overlay components (Region Capture, Screen Guide, and Window
 * Highlight) live as absolutely-positioned
 * children. The overlay window is hidden when idle and only shown when a
 * component activates, preventing it from blocking interaction with windows
 * below.
 *
 * Hit-testing: the renderer tracks visible component bounding rects and
 * notifies the main process to toggle `setIgnoreMouseEvents` accordingly.
 */

type WindowBounds = { x: number; y: number; width: number; height: number };
type WindowHighlightTone = "default" | "subtle";

type OverlayState = {
  windowHighlightBounds: WindowBounds | null;
  windowHighlightTone: WindowHighlightTone;
  regionCaptureActive: boolean;
};

type OverlayAction =
  | {
      type: "overlay:windowHighlight";
      bounds: WindowBounds | null;
      tone?: WindowHighlightTone;
    }
  | { type: "region"; active: boolean };

const initialState: OverlayState = {
  windowHighlightBounds: null,
  windowHighlightTone: "default",
  regionCaptureActive: false,
};

function overlayReducer(
  state: OverlayState,
  action: OverlayAction,
): OverlayState {
  switch (action.type) {
    case "overlay:windowHighlight":
      return {
        ...state,
        windowHighlightBounds: action.bounds,
        windowHighlightTone: action.bounds
          ? (action.tone ?? "default")
          : "default",
      };
    case "region":
      return state.regionCaptureActive === action.active
        ? state
        : {
            ...state,
            regionCaptureActive: action.active,
          };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook: useOverlayIPC
// Consolidates ALL IPC subscription effects (window highlight, region capture)
// into a single hook.
// ---------------------------------------------------------------------------
function useOverlayIPC(dispatch: Dispatch<OverlayAction>) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanups = [
      api.overlay.onWindowHighlight?.((payload) => {
        dispatch({
          type: "overlay:windowHighlight",
          bounds: payload
            ? {
                x: payload.x,
                y: payload.y,
                width: payload.width,
                height: payload.height,
              }
            : null,
          tone: payload?.tone,
        });
      }),
      api.overlay.onStartRegionCapture?.(() => {
        dispatch({
          type: "region",
          active: true,
        });
      }),
      api.overlay.onEndRegionCapture?.(() => {
        dispatch({ type: "region", active: false });
      }),
    ];

    return () => {
      for (const cleanup of cleanups) {
        cleanup?.();
      }
    };
  }, [dispatch]);
}

// ---------------------------------------------------------------------------
// Hook: useOverlayHitTesting
// Manages the overlay's setIgnoreMouseEvents toggle based on which overlay
// subsystems are currently active and whether the cursor is over an
// interactive region.
// ---------------------------------------------------------------------------
function useOverlayHitTesting(
  state: OverlayState,
  updateInteractive: (shouldBeInteractive: boolean) => void,
) {
  const { regionCaptureActive } = state;

  useEffect(() => {
    // Region capture is the only surface that takes the pointer; everything
    // else (window ring, screen guide) is purely decorative and click-through.
    updateInteractive(regionCaptureActive);
  }, [regionCaptureActive, updateInteractive]);
}

// ---------------------------------------------------------------------------
// Component: OverlayRoot
// Composes the hooks above and renders the overlay subsystem JSX.
// ---------------------------------------------------------------------------
export function OverlayRoot() {
  const [state, dispatch] = useReducer(overlayReducer, initialState);
  const interactiveRef = useRef<boolean | null>(null);

  useOverlayIPC(dispatch);

  const updateInteractive = useCallback((shouldBeInteractive: boolean) => {
    if (interactiveRef.current === shouldBeInteractive) return;
    interactiveRef.current = shouldBeInteractive;
    if (
      typeof window !== "undefined" &&
      window.electronAPI?.overlay?.setInteractive
    ) {
      window.electronAPI.overlay.setInteractive(shouldBeInteractive);
    }
  }, []);

  useEffect(() => {
    interactiveRef.current = null;
  }, [state.regionCaptureActive]);

  useOverlayHitTesting(state, updateInteractive);

  return (
    <div
      className="overlay-root"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: state.regionCaptureActive ? "auto" : "none",
        overflow: "hidden",
      }}
    >
      {state.windowHighlightBounds && (
        <div
          className={
            state.windowHighlightTone === "subtle"
              ? "capture-window-ring capture-window-ring--subtle"
              : "capture-window-ring"
          }
          style={{
            left: state.windowHighlightBounds.x,
            top: state.windowHighlightBounds.y,
            width: state.windowHighlightBounds.width,
            height: state.windowHighlightBounds.height,
          }}
        />
      )}

      {state.regionCaptureActive && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            pointerEvents: "auto",
          }}
        >
          <RegionCapture />
        </div>
      )}
    </div>
  );
}
