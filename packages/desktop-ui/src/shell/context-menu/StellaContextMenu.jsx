/**
 * Right-clicking the main app surface toggles the workspace sidebar.
 * Composer inputs keep their native context menu.
 */
import { useCallback, useRef } from "react";
export const isComposerContextMenuTarget = (target) => typeof Element !== "undefined" &&
    target instanceof Element &&
    Boolean(target.closest('[data-composer-context-menu="native"]'));
export function StellaContextMenu({ children, isOpen, onOpen, onClose, }) {
    const onOpenRef = useRef(onOpen);
    onOpenRef.current = onOpen;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const isOpenRef = useRef(isOpen);
    isOpenRef.current = isOpen;
    const handleContextMenu = useCallback((event) => {
        if (isComposerContextMenuTarget(event.target))
            return;
        event.preventDefault();
        if (isOpenRef.current) {
            onCloseRef.current();
        }
        else {
            onOpenRef.current();
        }
    }, []);
    return (<div onContextMenu={handleContextMenu} style={{ display: "contents" }}>
      {children}
    </div>);
}
