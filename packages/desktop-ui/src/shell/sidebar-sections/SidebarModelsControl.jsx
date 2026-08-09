/**
 * Models — a footer popover hosting the agent model picker. It never opens
 * or moves the right sidebar; it opens in place, from whichever footer the
 * user can currently see.
 *
 * Open state lives in the engine-overlay store (not local trigger state)
 * because external flows also open the picker: `openEngineDisplayTab()` and
 * the `stella:open-model-picker` event flip the same store.
 *
 * Both footers — Home's inside the panel and the workspace strip's when the
 * panel is closed — mount this control, and they share that one store. Only
 * the mounted-and-visible one may anchor the popover, which is what `active`
 * selects; the inactive instance renders a trigger and nothing else.
 */
import { lazy, Suspense, useEffect } from "react";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { composerModelPin, useComposerModelPinned } from "@/features/chat/composer-model-pin-store";
import { preloadModelsPicker } from "@/shell/topbar/nav-surface-preloads";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Switch } from "@/ui/switch";
import { SlidersHorizontal } from "@/ui/icons";

const AgentModelPicker = lazy(() => import("@/global/settings/AgentModelPicker").then((module) => ({
    default: module.AgentModelPicker,
})));

export function SidebarModelsControl({ active = true } = {}) {
    const modelsPickerOpen = useEngineOverlayOpen();
    const modelPinned = useComposerModelPinned();
    const open = modelsPickerOpen && active;

    useEffect(() => {
        if (open)
            preloadModelsPicker();
    }, [open]);

    return (<Popover open={open} onOpenChange={(next) => engineOverlay.setOpen(next)}>
      <PopoverTrigger asChild>
        <button type="button" className="pill-btn work-models-button" data-active={open || undefined} aria-pressed={open} onMouseEnter={preloadModelsPicker} onFocus={preloadModelsPicker}>
          <SlidersHorizontal size={14} strokeWidth={1.75}/>
          Models
        </button>
      </PopoverTrigger>
      <PopoverContent className="models-popover" side="top" align="end" sideOffset={8} collisionPadding={8}>
        <PopoverBody className="models-popover__body">
          <div className="models-popover__panel">
            <Suspense fallback={<div className="work-models-panel__loading" aria-busy="true" aria-live="polite">
                Loading…
              </div>}>
              <AgentModelPicker active={open}/>
            </Suspense>
          </div>
          <div className="models-popover__footer">
            <Switch className="work-models-pin-switch" label="Show in composer" checked={modelPinned} onCheckedChange={() => composerModelPin.toggle()}/>
          </div>
        </PopoverBody>
      </PopoverContent>
    </Popover>);
}
