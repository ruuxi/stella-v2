import * as React from "react";
import { X } from "@/ui/icons";
const ToastContext = React.createContext(null);
function useToast() {
    const context = React.useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
}
export function ToastProvider({ children }) {
    const [toasts, setToasts] = React.useState([]);
    const toastTimeoutsRef = React.useRef(new Map());
    const toastKeysRef = React.useRef(new Map());
    const removeToast = React.useCallback((id) => {
        const timeoutId = toastTimeoutsRef.current.get(id);
        if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
            toastTimeoutsRef.current.delete(id);
        }
        for (const [key, value] of toastKeysRef.current) {
            if (value === id) {
                toastKeysRef.current.delete(key);
                break;
            }
        }
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);
    const addToast = React.useCallback((options) => {
        const dedupeKey = `${options.variant ?? "default"}::${options.title ?? ""}::${options.description ?? ""}`;
        const existingId = toastKeysRef.current.get(dedupeKey);
        const id = existingId ?? Math.random().toString(36).substring(2, 9);
        if (existingId) {
            setToasts((prev) => prev.map((t) => (t.id === existingId ? { ...t, ...options, id: existingId } : t)));
            const prevTimeout = toastTimeoutsRef.current.get(existingId);
            if (prevTimeout !== undefined) {
                window.clearTimeout(prevTimeout);
                toastTimeoutsRef.current.delete(existingId);
            }
        }
        else {
            const toast = { id, ...options };
            setToasts((prev) => [...prev, toast]);
            toastKeysRef.current.set(dedupeKey, id);
        }
        if (options.duration !== 0) {
            const timeout = options.duration || 4000;
            const timeoutId = window.setTimeout(() => {
                toastKeysRef.current.delete(dedupeKey);
                removeToast(id);
            }, timeout);
            toastTimeoutsRef.current.set(id, timeoutId);
        }
        return id;
    }, [removeToast]);
    React.useEffect(() => {
        const toastTimeouts = toastTimeoutsRef.current;
        return () => {
            for (const timeoutId of toastTimeouts.values()) {
                window.clearTimeout(timeoutId);
            }
            toastTimeouts.clear();
        };
    }, []);
    const value = React.useMemo(() => ({ toasts, addToast, removeToast }), [toasts, addToast, removeToast]);
    React.useEffect(() => {
        const imperativeToast = (options) => addToast(typeof options === "string" ? { description: options } : options);
        setToastFn(imperativeToast);
        setDismissToastFn(removeToast);
        if (typeof window !== "undefined") {
            window.showToast = showToast;
        }
        return () => {
            if (toastFn === imperativeToast) {
                setToastFn(null);
            }
            if (dismissToastFn === removeToast) {
                setDismissToastFn(null);
            }
        };
    }, [addToast, removeToast]);
    return (<ToastContext.Provider value={value}>
      {children}
      <ToastRegion />
    </ToastContext.Provider>);
}
function ToastRegion() {
    const { toasts, removeToast } = useToast();
    return (<div data-component="toast-region">
      <ul data-slot="toast-list">
        {toasts.map((toast) => (<ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)}/>))}
      </ul>
    </div>);
}
function ToastItem({ toast, onClose }) {
    const handleActionClick = React.useCallback(() => {
        toast.action?.onClick();
        onClose();
    }, [onClose, toast.action]);
    const handleSecondaryActionClick = React.useCallback(() => {
        toast.secondaryAction?.onClick();
        onClose();
    }, [onClose, toast.secondaryAction]);
    return (<li data-component="toast" data-variant={toast.variant}>
      <div data-slot="toast-content">
        {toast.title && <div data-slot="toast-title">{toast.title}</div>}
        {toast.description && <div data-slot="toast-description">{toast.description}</div>}
        {(toast.action || toast.secondaryAction) && (<div data-slot="toast-actions">
            {toast.action && (<button data-slot="toast-action-button" onClick={handleActionClick} type="button">
                {toast.action.label}
              </button>)}
            {toast.secondaryAction && (<button data-slot="toast-action-button" data-variant="secondary" onClick={handleSecondaryActionClick} type="button">
                {toast.secondaryAction.label}
              </button>)}
          </div>)}
      </div>
      <button data-slot="toast-close-button" onClick={onClose} type="button">
        <X size={16}/>
      </button>
    </li>);
}
let toastFn = null;
let dismissToastFn = null;
function setToastFn(fn) {
    toastFn = fn;
}
function setDismissToastFn(fn) {
    dismissToastFn = fn;
}
export function showToast(options) {
    if (!toastFn) {
        console.warn("Toast provider not initialized");
        return "";
    }
    const opts = typeof options === "string" ? { description: options } : options;
    return toastFn(opts);
}
export function dismissToast(id) {
    if (!id)
        return;
    dismissToastFn?.(id);
}
// Window hook so we can fire toasts from the DevTools console while
// iterating on copy / styling.
if (typeof window !== "undefined") {
    window.showToast = showToast;
}
