/**
 * Modal — the accessible shell for hand-rolled modal surfaces.
 *
 * Most dialogs in the app ride on `ui/dialog.tsx` (Radix), which already
 * ships the dialog role, the focus trap, Esc-to-close and focus restore.
 * A few surfaces cannot use it: they must render *inside* a specific
 * layout box rather than a body portal (the chat-column focus overlay),
 * or they predate the primitive entirely (the screenshot preview). This
 * is the tiny in-house equivalent for those — no new dependency, and
 * deliberately unopinionated about looks: every visual decision stays in
 * the caller's own class names.
 *
 * What it guarantees:
 *  - `role="dialog"` + `aria-modal="true"` on the panel
 *  - an accessible name via `aria-labelledby` or `aria-label`, and an
 *    optional `aria-describedby`
 *  - focus moved into the panel on open (explicit target, else the first
 *    tabbable, else the panel itself)
 *  - Tab / Shift+Tab cycling inside the panel
 *  - Escape closes the topmost open modal only
 *  - focus restored to whatever opened it on close
 *  - the rest of the page marked `inert` + `aria-hidden` while open
 *
 * Motion is left to CSS: the app's global `html[data-reduce-motion="reduce"]`
 * rule in `index.css` already neutralizes animations, so callers keep the
 * animations they had and inherit the same reduced-motion behavior.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const TABBABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

const isVisible = (element: HTMLElement) => {
  if (element.hidden || element.closest("[hidden]") !== null) return false;
  // `checkVisibility` covers `display:none`/`visibility:hidden` ancestors
  // without forcing layout. Anything older simply keeps the element.
  const check = (element as HTMLElement & { checkVisibility?: () => boolean })
    .checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
};

/** Tabbable descendants of `root`, in document order. */
export function getTabbableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      Number(element.getAttribute("tabindex") ?? "0") >= 0 &&
      element.closest("[inert]") === null &&
      isVisible(element),
  );
}

/**
 * Open modals, innermost last. Escape and the background-inert bookkeeping
 * both read this so nested modals behave (only the top one closes, and the
 * page is un-inerted only once the last one goes away).
 */
const modalStack: HTMLElement[] = [];

const isTopmost = (panel: HTMLElement | null) =>
  panel !== null && modalStack[modalStack.length - 1] === panel;

/**
 * Mark everything outside `root` as inert for assistive tech and for the
 * tab order. Returns the undo.
 */
function inertBackground(root: HTMLElement): () => void {
  const undo: Array<() => void> = [];
  let node: HTMLElement | null = root;
  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    const self = node;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === self || !(sibling instanceof HTMLElement)) continue;
      if (sibling.dataset.stellaModalInert === "1") continue;
      const previousAriaHidden = sibling.getAttribute("aria-hidden");
      const wasInert = sibling.hasAttribute("inert");
      sibling.dataset.stellaModalInert = "1";
      sibling.setAttribute("aria-hidden", "true");
      if (!wasInert) sibling.setAttribute("inert", "");
      undo.push(() => {
        delete sibling.dataset.stellaModalInert;
        if (previousAriaHidden === null) sibling.removeAttribute("aria-hidden");
        else sibling.setAttribute("aria-hidden", previousAriaHidden);
        if (!wasInert) sibling.removeAttribute("inert");
      });
    }
    node = parent === document.body ? null : parent;
  }
  return () => {
    for (const step of undo) step();
  };
}

export type ModalProps = {
  /** Called for Escape, a backdrop click, or any caller-driven dismissal. */
  onClose: () => void;
  children: ReactNode;
  /** Id of the element naming the dialog. Prefer this over `label`. */
  labelledBy?: string;
  /** Literal accessible name, when no visible title element exists. */
  label?: string;
  /** Id of the element describing the dialog. */
  describedBy?: string;
  /** Class for the `role="dialog"` panel — this is the visual surface. */
  className?: string;
  /** Inline style for the `role="dialog"` panel. */
  style?: CSSProperties;
  /** Class for the backdrop element that wraps the panel. */
  backdropClassName?: string;
  /** Inline style for the backdrop element. */
  backdropStyle?: CSSProperties;
  /** Extra data-/aria- attributes for the backdrop (test ids, hooks). */
  backdropProps?: Record<string, string | undefined>;
  /** Focus this on open instead of the first tabbable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Pointer-down on the backdrop itself dismisses. Default true. */
  closeOnBackdropClick?: boolean;
  /**
   * True (default) for a real modal: `aria-modal`, a focus trap, and an
   * inert page behind it. Pass false for a dialog that deliberately
   * leaves a surface outside it usable (the chat focus overlay keeps the
   * composer live) — it still gets the dialog role, Escape, focus-in and
   * focus restore, just not the trap or the inert background.
   */
  modal?: boolean;
  /**
   * Where to render. `null` (default) keeps the modal inline, in the
   * caller's own layout box; pass an element to portal there.
   */
  container?: HTMLElement | null;
};

export function Modal({
  onClose,
  children,
  labelledBy,
  label,
  describedBy,
  className,
  style,
  backdropClassName,
  backdropStyle,
  backdropProps,
  initialFocusRef,
  closeOnBackdropClick = true,
  modal = true,
  container = null,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Register in the stack and inert the background before paint, so a
  // screen reader never sees the page in its "both are live" state.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement;
    modalStack.push(panel);
    const restoreBackground = modal ? inertBackground(panel) : () => {};
    return () => {
      restoreBackground();
      const index = modalStack.indexOf(panel);
      if (index >= 0) modalStack.splice(index, 1);
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [modal]);

  // Move focus in once the content has mounted.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const explicit = initialFocusRef?.current;
    const target = explicit ?? getTabbableElements(panel)[0] ?? panel;
    target.focus({ preventScroll: true });
    // Only on open: later re-renders must not yank focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || event.defaultPrevented || !isTopmost(panel)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !modal) return;
      const tabbables = getTabbableElements(panel);
      if (tabbables.length === 0) {
        // Nothing to land on — keep focus on the panel rather than
        // letting it escape into the inert page behind.
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.contains(active);
      if (event.shiftKey && (!inside || active === first || active === panel)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modal]);

  const handleBackdropPointerDown = useCallback(
    (event: React.MouseEvent) => {
      if (!closeOnBackdropClick) return;
      if (event.target !== event.currentTarget) return;
      onCloseRef.current();
    },
    [closeOnBackdropClick],
  );

  const tree = (
    <div
      className={backdropClassName}
      style={backdropStyle}
      onMouseDown={handleBackdropPointerDown}
      {...backdropProps}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal ? "true" : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        // The panel is the focus fallback when it holds nothing tabbable.
        tabIndex={-1}
        className={className}
        style={style}
      >
        {children}
      </div>
    </div>
  );

  return container ? createPortal(tree, container) : tree;
}
