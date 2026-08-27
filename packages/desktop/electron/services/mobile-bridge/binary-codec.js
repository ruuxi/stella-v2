export const BRIDGE_BINARY_TAG = "__stellaBridgeBinary";

const MAX_DEPTH = 8;
const toBase64 = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
const encodeView = (view) => ({
    [BRIDGE_BINARY_TAG]: "base64",
    data: toBase64(view),
    byteLength: view.byteLength,
});

export const encodeBridgeBinaryValues = (value, depth = 0) => {
    if (value instanceof Uint8Array)
        return encodeView(value);
    if (value instanceof ArrayBuffer)
        return encodeView(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
        const view = value;
        return encodeView(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((entry) => {
            const encoded = encodeBridgeBinaryValues(entry, depth + 1);
            if (encoded !== entry)
                changed = true;
            return encoded;
        });
        return changed ? next : value;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return value;
    let changed = false;
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
        const encoded = encodeBridgeBinaryValues(entry, depth + 1);
        if (encoded !== entry)
            changed = true;
        next[key] = encoded;
    }
    return changed ? next : value;
};
