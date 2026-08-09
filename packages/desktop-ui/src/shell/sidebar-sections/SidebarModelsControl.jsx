/**
 * Models — a footer popover hosting the agent model picker.
 *
 * Open state stays in the engine-overlay store (not local trigger state)
 * because external flows also open the picker: `openEngineDisplayTab()` and
 * the `stella:open-model-picker` event both flip the store after opening
 * the sidebar on Home, and the popover then springs from the footer button.
 *
 * `openSidebar` renders the plain-button variant used outside the sidebar
 * (the workspace home surface): it routes to Home and opens the popover.
 */
import { lazy, Suspense, useEffect } from "react";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { composerModelPin, useComposerModelPinned } from "@/features/chat/composer-model-pin-store";
import { preloadModelsPicker } from "@/shell/topbar/nav-surface-preloads";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { SlidersHorizontal } from "@/ui/icons";

const AgentModelPicker = lazy(() => import("@/global/settings/AgentModelPicker").then((module) => ({
    default: module.AgentModelPicker,
})));

export function SidebarModelsControl({ openSidebar = false } = {}) {
    const modelsPickerOpen = useEngineOverlayOpen();
    const modelPinned = useComposerModelPinned();

    useEffect(() => {
        if (modelsPickerOpen)
            preloadModelsPicker();
    }, [modelsPickerOpen]);

    if (openSidebar) {
        return (<button type="button" className="pill-btn work-models-button" data-active={modelsPickerOpen || undefined} aria-pressed={modelsPickerOpen} onMouseEnter={preloadModelsPicker} onFocus={preloadModelsPicker} onClick={() => {
                sidebarSections.setActiveSection("files");
                displayTabs.setPanelOpen(true);
                engineOverlay.setOpen(true);
            }}>
        <SlidersHorizontal size={14} strokeWidth={1.75}/>
        Models
      </button>);
    }

    return (<Popover open={modelsPickerOpen} onOpenChange={(open) => engineOverlay.setOpen(open)}>
      <PopoverTrigger asChild>
        <button type="button" className="pill-btn work-models-button" data-active={modelsPickerOpen || undefined} aria-pressed={modelsPickerOpen} onMouseEnter={preloadModelsPicker} onFocus={preloadModelsPicker}>
          <SlidersHorizontal size={14} strokeWidth={1.75}/>
          Models
        </button>
      </PopoverTrigger>
      <PopoverContent className="models-popover" side="top" align="end" sideOffset={8}>
        <PopoverBody className="models-popover__body">
          <div className="models-popover__panel">
            <Suspense fallback={<div className="work-models-panel__loading" aria-busy="true" aria-live="polite">
                Loading…
              </div>}>
              <AgentModelPicker active={modelsPickerOpen}/>
            </Suspense>
          </div>
          <div className="models-popover__footer">
            <button type="button" className="pill-btn work-models-pin-button" data-active={modelPinned || undefined} aria-pressed={modelPinned} onClick={() => composerModelPin.toggle()}>
              Show in composer
            </button>
          </div>
        </PopoverBody>
      </PopoverContent>
    </Popover>);
}
