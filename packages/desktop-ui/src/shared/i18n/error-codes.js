/**
 * Map known `ConvexError` codes (as thrown by the backend) to
 * localized message keys in the renderer's i18n catalogs. Backend
 * `ConvexError` always carries an English `message` for logs/devs;
 * the renderer should call `localizeBackendError` to surface the
 * user-friendly version in their language.
 */
import { translate } from "./catalogs";
const CODE_TO_KEY = {
    RATE_LIMITED: "errors.rateLimited",
    SUBSCRIPTION_REQUIRED: "errors.subscriptionRequired",
    NETWORK_UNAVAILABLE: "errors.networkUnavailable",
    PERMISSION_DENIED: "errors.permissionDenied",
};
const extractCode = (error) => {
    if (!error || typeof error !== "object")
        return undefined;
    const data = error.data;
    if (data && typeof data === "object") {
        const code = data.code;
        if (typeof code === "string" && code.trim())
            return code.trim();
    }
    return undefined;
};
const extractFallbackMessage = (error) => {
    if (!error)
        return undefined;
    if (typeof error === "object") {
        const data = error.data;
        if (data && typeof data === "object") {
            const message = data.message;
            if (typeof message === "string" && message.trim())
                return message.trim();
        }
        const message = error.message;
        if (typeof message === "string" && message.trim())
            return message.trim();
    }
    return undefined;
};
/**
 * Resolve a backend error to a localized message. Pass the active
 * catalog (from `useI18n().t` callsites or from the fallback) and an
 * optional generic-error fallback string.
 *
 * Returns the localized string for known codes, otherwise the
 * backend's English `message`, otherwise the generic-error
 * translation.
 */
export const localizeBackendError = (error, catalog, params) => {
    const code = extractCode(error);
    if (code && CODE_TO_KEY[code]) {
        return translate(catalog, CODE_TO_KEY[code], params);
    }
    const fallback = extractFallbackMessage(error);
    if (fallback)
        return fallback;
    return translate(catalog, "errors.generic", params);
};
