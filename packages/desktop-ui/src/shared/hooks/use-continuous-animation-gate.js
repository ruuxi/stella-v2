import { useEffect, useState, useSyncExternalStore, } from "react";
const readEnvironment = () => {
    if (typeof document === "undefined" || typeof window === "undefined") {
        return {
            documentVisible: true,
            reducedMotion: false,
            windowFocused: true,
        };
    }
    return {
        documentVisible: document.visibilityState !== "hidden",
        reducedMotion: document.documentElement.getAttribute("data-reduce-motion") ===
            "reduce" ||
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
        windowFocused: document.hasFocus(),
    };
};
let environmentSnapshot = readEnvironment();
const environmentListeners = new Set();
let stopEnvironmentListeners = null;
const getEnvironmentSnapshot = () => {
    const next = readEnvironment();
    if (next.documentVisible !== environmentSnapshot.documentVisible ||
        next.reducedMotion !== environmentSnapshot.reducedMotion ||
        next.windowFocused !== environmentSnapshot.windowFocused) {
        environmentSnapshot = next;
    }
    return environmentSnapshot;
};
const syncEnvironment = () => {
    const next = readEnvironment();
    if (next.documentVisible === environmentSnapshot.documentVisible &&
        next.reducedMotion === environmentSnapshot.reducedMotion &&
        next.windowFocused === environmentSnapshot.windowFocused) {
        return;
    }
    environmentSnapshot = next;
    for (const listener of environmentListeners)
        listener();
};
const startEnvironmentListeners = () => {
    if (typeof document === "undefined" || typeof window === "undefined") {
        return () => { };
    }
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const attributeObserver = typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(syncEnvironment);
    attributeObserver?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-reduce-motion"],
    });
    document.addEventListener("visibilitychange", syncEnvironment);
    window.addEventListener("focus", syncEnvironment);
    window.addEventListener("blur", syncEnvironment);
    media?.addEventListener?.("change", syncEnvironment);
    syncEnvironment();
    return () => {
        attributeObserver?.disconnect();
        document.removeEventListener("visibilitychange", syncEnvironment);
        window.removeEventListener("focus", syncEnvironment);
        window.removeEventListener("blur", syncEnvironment);
        media?.removeEventListener?.("change", syncEnvironment);
    };
};
const subscribeToAnimationEnvironment = (listener) => {
    environmentListeners.add(listener);
    if (environmentListeners.size === 1) {
        stopEnvironmentListeners = startEnvironmentListeners();
    }
    return () => {
        environmentListeners.delete(listener);
        if (environmentListeners.size === 0) {
            stopEnvironmentListeners?.();
            stopEnvironmentListeners = null;
        }
    };
};
export const shouldRunContinuousAnimation = ({ documentVisible, elementVisible, logicalActive, reducedMotion, requireWindowFocus = false, windowFocused, }) => logicalActive &&
    elementVisible &&
    documentVisible &&
    !reducedMotion &&
    (!requireWindowFocus || windowFocused);
const isElementPresentationVisible = (element) => {
    let current = element;
    while (current) {
        // The left sidebar's collapsed state used to need its own class check
        // here because it animated to zero width while staying visible. The right
        // sidebar's closed state hides kept content with `display: none`, which
        // the computed-style check below already catches.
        if (current.hidden ||
            current.inert ||
            current.dataset.collapsed === "true") {
            return false;
        }
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }
        current = current.parentElement;
    }
    return true;
};
/**
 * The shared contract for persistent UI motion: it runs only for live state,
 * while its element and document are visible, and while motion is allowed.
 */
export function useContinuousAnimationGate({ active, elementRef, requireWindowFocus = false, rootMargin = "0px", }) {
    const environment = useSyncExternalStore(subscribeToAnimationEnvironment, getEnvironmentSnapshot, () => ({
        documentVisible: true,
        reducedMotion: false,
        windowFocused: true,
    }));
    const [elementVisible, setElementVisible] = useState(false);
    useEffect(() => {
        if (!active) {
            setElementVisible(false);
            return;
        }
        const element = elementRef.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setElementVisible(element ? isElementPresentationVisible(element) : true);
            return;
        }
        let intersectsViewport = false;
        const syncElementVisibility = () => {
            setElementVisible(intersectsViewport && isElementPresentationVisible(element));
        };
        const observer = new IntersectionObserver(([entry]) => {
            intersectsViewport = Boolean(entry?.isIntersecting);
            syncElementVisibility();
        }, { rootMargin, threshold: 0 });
        observer.observe(element);
        const presentationObserver = new MutationObserver(syncElementVisibility);
        let ancestor = element;
        while (ancestor) {
            presentationObserver.observe(ancestor, {
                attributes: true,
                attributeFilter: ["class", "data-collapsed", "hidden", "inert"],
            });
            ancestor = ancestor.parentElement;
        }
        return () => {
            observer.disconnect();
            presentationObserver.disconnect();
        };
    }, [active, elementRef, rootMargin]);
    return shouldRunContinuousAnimation({
        documentVisible: environment.documentVisible,
        elementVisible,
        logicalActive: active,
        reducedMotion: environment.reducedMotion,
        requireWindowFocus,
        windowFocused: environment.windowFocused,
    });
}
