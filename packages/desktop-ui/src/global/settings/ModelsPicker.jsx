import { cloneElement, isValidElement, lazy, Suspense, useCallback, useEffect, useState, } from "react";
import { preloadModelsPicker } from "@/shell/topbar/nav-surface-preloads";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger, } from "@/ui/popover";
import "./ModelsPicker.css";
const AgentModelPicker = lazy(() => import("@/global/settings/AgentModelPicker").then((m) => ({
    default: m.AgentModelPicker,
})));
/**
 * Topbar entry-point for the model picker. The popover renders a single
 * `AgentModelPicker` directly — no nested dropdowns — with the agent toggle
 * sitting at the top of the picker itself.
 */
export function ModelsPicker({ trigger, side = "top", align = "start", open: controlledOpen, onOpenChange: controlledOnOpenChange, hideTrigger = false, }) {
    const [internalOpen, setInternalOpen] = useState(false);
    const [hasOpened, setHasOpened] = useState(false);
    const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
    useEffect(() => {
        if (!open)
            return;
        setHasOpened(true);
        preloadModelsPicker();
    }, [open]);
    const setOpen = useCallback((nextOpen) => {
        if (nextOpen) {
            setHasOpened(true);
            preloadModelsPicker();
        }
        (controlledOnOpenChange ?? setInternalOpen)(nextOpen);
    }, [controlledOnOpenChange]);
    const triggerElement = trigger && isValidElement(trigger)
        ? cloneElement(trigger, {
            "data-slot": "models-picker-trigger",
            onFocus: (event) => {
                preloadModelsPicker();
                trigger.props.onFocus?.(event);
            },
            onMouseEnter: (event) => {
                preloadModelsPicker();
                trigger.props.onMouseEnter?.(event);
            },
            ...(hideTrigger
                ? {
                    style: {
                        ...(typeof trigger.props.style === "object" &&
                            trigger.props.style !== null
                            ? trigger.props.style
                            : {}),
                        opacity: 0,
                        pointerEvents: "none",
                        position: "absolute",
                    },
                    tabIndex: -1,
                    "aria-hidden": true,
                }
                : null),
        })
        : trigger;
    return (<Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
      <PopoverContent forceMount side={side} align={align} collisionPadding={8} data-models-picker="true">
        <PopoverBody>
          {hasOpened ? (<Suspense fallback={<div className="models-picker-loading" aria-busy="true" aria-live="polite">
                  Loading…
                </div>}>
              <AgentModelPicker active={open}/>
            </Suspense>) : null}
        </PopoverBody>
      </PopoverContent>
    </Popover>);
}
