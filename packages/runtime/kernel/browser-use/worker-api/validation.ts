/**
 * Argument validation for the Node REPL worker's `browser` object. Agents
 * call that API with arbitrary values, so every option bag is checked here
 * before anything crosses into the browser session.
 */

import { requireNonNegativeInteger } from "../protocol.js";

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  return (
    Object.getPrototypeOf(prototype) === null &&
    typeof prototype.constructor === "function" &&
    prototype.constructor.name === "Object"
  );
};

export const requireString = (
  value: unknown,
  name: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string => {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0)
  ) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${name} must not contain a null byte.`);
  }
  if (value.length > (options.maxLength ?? 100_000)) {
    throw new RangeError(`${name} is too long.`);
  }
  return value;
};

export const requireFiniteNonNegative = (
  value: unknown,
  name: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number.`);
  }
  return value;
};

export const rejectRegExp = (value: unknown, name: string): void => {
  if (Object.prototype.toString.call(value) === "[object RegExp]") {
    throw new TypeError(`${name} does not support RegExp; pass a string.`);
  }
};

export const requireSelectorText = (value: unknown, name: string): string => {
  rejectRegExp(value, name);
  return requireString(value, name, { maxLength: 8_192 });
};

export const requireOptions = (
  value: unknown,
  name: string,
): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
};

export const assertKnownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${name} contains unsupported option '${key}'.`);
    }
  }
};

export const snapshotParams = (
  tabId: number,
  rawOptions: unknown,
): Record<string, unknown> => {
  const value = requireOptions(rawOptions, "snapshot options");
  assertKnownKeys(
    value,
    ["interactive", "cursor", "maxDepth", "depth", "compact", "selector"],
    "snapshot options",
  );
  const params: Record<string, unknown> = { tabId };
  for (const key of ["interactive", "cursor", "compact"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new TypeError(`${key} must be a boolean.`);
      }
      params[key] = value[key];
    }
  }
  const depth = value.maxDepth ?? value.depth;
  if (depth !== undefined) {
    params.maxDepth = requireNonNegativeInteger(depth, "maxDepth");
  }
  if (value.selector !== undefined) {
    params.selector = requireSelectorText(value.selector, "selector");
  }
  return params;
};

export const screenshotParams = (
  tabId: number,
  rawOptions: unknown,
): Record<string, unknown> => {
  const value = requireOptions(rawOptions, "screenshot options");
  assertKnownKeys(
    value,
    ["fullPage", "selector", "format", "quality", "annotate"],
    "screenshot options",
  );
  const params: Record<string, unknown> = { tabId };
  if (value.fullPage !== undefined) {
    if (typeof value.fullPage !== "boolean") {
      throw new TypeError("fullPage must be a boolean.");
    }
    params.fullPage = value.fullPage;
  }
  if (value.annotate !== undefined) {
    if (typeof value.annotate !== "boolean") {
      throw new TypeError("annotate must be a boolean.");
    }
    params.annotate = value.annotate;
  }
  if (value.selector !== undefined) {
    params.selector = requireSelectorText(value.selector, "selector");
  }
  if (value.format !== undefined) {
    const format = requireString(value.format, "format");
    if (format !== "png" && format !== "jpeg") {
      throw new TypeError("format must be 'png' or 'jpeg'.");
    }
    params.format = format;
  }
  if (value.quality !== undefined) {
    const quality = requireNonNegativeInteger(value.quality, "quality");
    if (quality > 100) throw new RangeError("quality must be at most 100.");
    params.quality = quality;
  }
  return params;
};

export const timeoutParam = (
  value: unknown,
  name: string,
  maximum = 120_000,
): number => {
  const timeout = requireNonNegativeInteger(value, name);
  if (timeout > maximum) {
    throw new RangeError(`${name} must be at most ${maximum}.`);
  }
  return timeout;
};

export const serializeArgument = (value: unknown): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("evaluate argument must be JSON-serializable.");
  }
  if (serialized === undefined) {
    throw new TypeError("evaluate argument must be JSON-serializable.");
  }
  return serialized;
};

export const functionSource = (value: unknown, name: string): string => {
  if (typeof value === "string") {
    return requireString(value, name, { maxLength: 100_000 });
  }
  if (typeof value !== "function") {
    throw new TypeError(
      `${name} must be a function or function source string.`,
    );
  }
  const source = Function.prototype.toString.call(value);
  if (source.includes("[native code]")) {
    throw new TypeError(`${name} must not be a native or bound function.`);
  }
  return source;
};

export const pageEvaluateScript = (
  pageFunction: unknown,
  arg: unknown,
  hasArgument: boolean,
): string => {
  if (typeof pageFunction === "string" && !hasArgument) {
    return functionSource(pageFunction, "pageFunction");
  }
  const source = functionSource(pageFunction, "pageFunction");
  return `(${source})(${hasArgument ? serializeArgument(arg) : ""})`;
};

export const safeJsonValue = (
  value: unknown,
  path: string,
  depth = 0,
): unknown => {
  if (depth > 12) throw new TypeError(`${path} is too deeply nested.`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      safeJsonValue(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must contain only JSON values.`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError(`${path} contains unsafe key '${key}'.`);
    }
    result[key] = safeJsonValue(nested, `${path}.${key}`, depth + 1);
  }
  return result;
};
