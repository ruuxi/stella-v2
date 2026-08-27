/**
 * Allocation-aware value and text bounds for Cloud Code.
 *
 * The normal JSON helpers allocate the complete serialization before a caller
 * can inspect its size. Values crossing the Dynamic Worker RPC boundary must
 * instead be measured while they are copied into a JSON-safe representation.
 */

export type BoundedJsonLimits = Readonly<{
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxEntries: number;
  maxStringBytes: number;
}>;

export type BoundedJsonCloneResult =
  | Readonly<{ ok: true; value: unknown; bytes: number }>
  | Readonly<{ ok: false; reason: string }>;

type CloneState = {
  bytes: number;
  nodes: number;
  entries: number;
  failure?: string;
  ancestors: WeakSet<object>;
};

const byteWidth = (value: string, index: number): readonly [number, number] => {
  const code = value.charCodeAt(index);
  if (code <= 0x7f) return [1, 1];
  if (code <= 0x7ff) return [2, 1];
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [4, 2];
  }
  return [3, 1];
};

/** Count UTF-8 bytes without allocating an encoded copy. Stops above max. */
export const utf8ByteLengthUpTo = (
  value: string,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const [width, consumed] = byteWidth(value, index);
    bytes += width;
    if (bytes > max) return max + 1;
    index += consumed;
  }
  return bytes;
};

const jsonStringBytesUpTo = (value: string, max: number): number => {
  let bytes = 2;
  if (bytes > max) return max + 1;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    let width: number;
    let consumed = 1;
    if (code === 0x22 || code === 0x5c) {
      width = 2;
    } else if (code <= 0x1f) {
      // Conservatively account for the longest JSON control escape.
      width = 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4;
        consumed = 2;
      } else {
        width = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      width = 6;
    } else {
      [width] = byteWidth(value, index);
    }
    bytes += width;
    if (bytes > max) return max + 1;
    index += consumed;
  }
  return bytes;
};

const fail = (state: CloneState, reason: string): undefined => {
  state.failure ??= reason;
  return undefined;
};

const addBytes = (
  state: CloneState,
  limits: BoundedJsonLimits,
  bytes: number,
): boolean => {
  state.bytes += bytes;
  if (state.bytes <= limits.maxBytes) return true;
  fail(state, "serialized byte limit exceeded");
  return false;
};

const copyJsonValue = (
  value: unknown,
  depth: number,
  state: CloneState,
  limits: BoundedJsonLimits,
): unknown => {
  if (state.failure) return undefined;
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    return fail(state, "node limit exceeded");
  }
  if (depth > limits.maxDepth) {
    return fail(state, "depth limit exceeded");
  }

  if (value === null) {
    addBytes(state, limits, 4);
    return null;
  }
  if (typeof value === "string") {
    if (utf8ByteLengthUpTo(value, limits.maxStringBytes) > limits.maxStringBytes) {
      return fail(state, "string byte limit exceeded");
    }
    const remaining = Math.max(0, limits.maxBytes - state.bytes);
    const bytes = jsonStringBytesUpTo(value, remaining);
    if (bytes > remaining) return fail(state, "serialized byte limit exceeded");
    state.bytes += bytes;
    return value;
  }
  if (typeof value === "boolean") {
    addBytes(state, limits, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    const normalized = Number.isFinite(value) ? value : null;
    addBytes(
      state,
      limits,
      normalized === null ? 4 : String(normalized).length,
    );
    return normalized;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return fail(state, `unsupported ${typeof value} value`);
  }
  if (!value || typeof value !== "object") {
    return fail(state, "unsupported value");
  }
  if (state.ancestors.has(value)) {
    return fail(state, "cyclic value");
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxEntries - state.entries) {
        return fail(state, "entry limit exceeded");
      }
      state.entries += value.length;
      if (!addBytes(state, limits, 2 + Math.max(0, value.length - 1))) {
        return undefined;
      }
      const copied = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && !("value" in descriptor)) {
          return fail(state, "accessor values are not allowed");
        }
        const nested = descriptor ? descriptor.value : null;
        copied[index] = copyJsonValue(nested, depth + 1, state, limits);
        if (state.failure) return undefined;
      }
      return copied;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(state, "custom object prototypes are not allowed");
    }
    if (!addBytes(state, limits, 2)) return undefined;

    const copied: Record<string, unknown> = {};
    let first = true;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      state.entries += 1;
      if (state.entries > limits.maxEntries) {
        return fail(state, "entry limit exceeded");
      }
      if (utf8ByteLengthUpTo(key, limits.maxStringBytes) > limits.maxStringBytes) {
        return fail(state, "key byte limit exceeded");
      }
      const remaining = Math.max(0, limits.maxBytes - state.bytes);
      const keyBytes = jsonStringBytesUpTo(key, remaining);
      if (
        keyBytes > remaining ||
        !addBytes(state, limits, keyBytes + 1 + (first ? 0 : 1))
      ) {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return fail(state, "accessor values are not allowed");
      }
      const nested = copyJsonValue(descriptor.value, depth + 1, state, limits);
      if (state.failure) return undefined;
      Object.defineProperty(copied, key, {
        value: nested,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      first = false;
    }
    return copied;
  } finally {
    state.ancestors.delete(value);
  }
};

/**
 * Copy a value into a plain JSON-safe graph while enforcing every limit before
 * JSON.stringify or Workers RPC gets a chance to allocate an unbounded copy.
 */
export const cloneBoundedJsonValue = (
  value: unknown,
  limits: BoundedJsonLimits,
): BoundedJsonCloneResult => {
  const state: CloneState = {
    bytes: 0,
    nodes: 0,
    entries: 0,
    ancestors: new WeakSet<object>(),
  };
  const copied = copyJsonValue(value, 0, state, limits);
  if (state.failure) return { ok: false, reason: state.failure };
  return { ok: true, value: copied, bytes: state.bytes };
};

/** Return the longest UTF-8 prefix that fits, without splitting a pair. */
export const utf8Prefix = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const [width, consumed] = byteWidth(value, index);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += consumed;
  }
  return index === value.length ? value : value.slice(0, index);
};

export const truncateUtf8 = (
  value: string,
  maxBytes: number,
  suffix = "\n\n[Code output truncated.]",
): string => {
  if (utf8ByteLengthUpTo(value, maxBytes) <= maxBytes) return value;
  const suffixBytes = utf8ByteLengthUpTo(suffix, maxBytes);
  if (suffixBytes > maxBytes) return utf8Prefix(suffix, maxBytes);
  return `${utf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
};

type TextWriter = {
  parts: string[];
  bytes: number;
  maxBytes: number;
  truncated: boolean;
};

const appendText = (writer: TextWriter, value: string): void => {
  if (writer.truncated || value.length === 0) return;
  const remaining = writer.maxBytes - writer.bytes;
  const size = utf8ByteLengthUpTo(value, remaining);
  if (size <= remaining) {
    writer.parts.push(value);
    writer.bytes += size;
    return;
  }
  const prefix = utf8Prefix(value, remaining);
  if (prefix) {
    writer.parts.push(prefix);
    writer.bytes += utf8ByteLengthUpTo(prefix);
  }
  writer.truncated = true;
};

const appendJsonString = (writer: TextWriter, value: string): void => {
  appendText(writer, '"');
  let runStart = 0;
  for (let index = 0; index < value.length && !writer.truncated; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    if (code === 0x22) escaped = '\\"';
    else if (code === 0x5c) escaped = "\\\\";
    else if (code === 0x08) escaped = "\\b";
    else if (code === 0x09) escaped = "\\t";
    else if (code === 0x0a) escaped = "\\n";
    else if (code === 0x0c) escaped = "\\f";
    else if (code === 0x0d) escaped = "\\r";
    else if (code <= 0x1f) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      escaped = `\\u${code.toString(16)}`;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escaped = `\\u${code.toString(16)}`;
    }
    if (!escaped) continue;
    appendText(writer, value.slice(runStart, index));
    appendText(writer, escaped);
    runStart = index + 1;
  }
  if (!writer.truncated) appendText(writer, value.slice(runStart));
  appendText(writer, '"');
};

const writePreview = (
  writer: TextWriter,
  value: unknown,
  depth: number,
  state: { nodes: number; ancestors: WeakSet<object> },
): void => {
  if (writer.truncated) return;
  state.nodes += 1;
  if (depth > 8 || state.nodes > 2_048) {
    appendJsonString(writer, "[Preview limit reached]");
    return;
  }
  if (value === null) return appendText(writer, "null");
  if (typeof value === "string") return appendJsonString(writer, value);
  if (typeof value === "boolean") return appendText(writer, String(value));
  if (typeof value === "number") {
    return appendText(writer, Number.isFinite(value) ? String(value) : "null");
  }
  if (typeof value === "undefined") return appendText(writer, "undefined");
  if (typeof value === "bigint") return appendJsonString(writer, "[bigint]");
  if (typeof value === "function") return appendJsonString(writer, "[function]");
  if (typeof value === "symbol") return appendJsonString(writer, "[symbol]");
  if (!value || typeof value !== "object") {
    return appendJsonString(writer, "[unsupported]");
  }
  if (state.ancestors.has(value)) return appendJsonString(writer, "[Circular]");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      appendText(writer, "[");
      const count = Math.min(value.length, 128);
      for (let index = 0; index < count && !writer.truncated; index += 1) {
        if (index > 0) appendText(writer, ", ");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        writePreview(
          writer,
          descriptor && "value" in descriptor ? descriptor.value : null,
          depth + 1,
          state,
        );
      }
      if (value.length > count) {
        if (count > 0) appendText(writer, ", ");
        appendJsonString(writer, `[${value.length - count} more items]`);
      }
      appendText(writer, "]");
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      appendJsonString(writer, "[Unsupported object]");
      return;
    }
    appendText(writer, "{");
    let count = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count >= 128) {
        if (count > 0) appendText(writer, ", ");
        appendJsonString(writer, "[more properties]");
        appendText(writer, ": true");
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (count > 0) appendText(writer, ", ");
      appendJsonString(writer, key);
      appendText(writer, ": ");
      if (!descriptor || !("value" in descriptor)) {
        appendJsonString(writer, "[Accessor]");
      } else {
        writePreview(writer, descriptor.value, depth + 1, state);
      }
      count += 1;
      if (writer.truncated) break;
    }
    appendText(writer, "}");
  } finally {
    state.ancestors.delete(value);
  }
};

/** Build a bounded JSON-like model preview without first serializing it. */
export const boundedJsonPreview = (value: unknown, maxBytes: number): string => {
  const suffix = "\n\n[Code output truncated.]";
  const suffixBytes = utf8ByteLengthUpTo(suffix);
  const writer: TextWriter = {
    parts: [],
    bytes: 0,
    maxBytes: Math.max(0, maxBytes - suffixBytes),
    truncated: false,
  };
  writePreview(writer, value, 0, {
    nodes: 0,
    ancestors: new WeakSet<object>(),
  });
  const output = writer.parts.join("");
  return writer.truncated ? `${output}${suffix}` : output;
};
