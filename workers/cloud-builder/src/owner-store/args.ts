/**
 * Argument parsers for backend functions. Each parser takes untrusted JSON
 * and returns the typed value or throws `RpcError("BAD_REQUEST")` naming the
 * offending path. Deliberately small: the shapes crossing the RPC boundary
 * are flat records of strings, numbers and booleans.
 */

import { RpcError } from "./errors.js";

export type Parser<T> = (value: unknown, path?: string) => T;

const fail = (path: string, expected: string): never => {
  throw new RpcError("BAD_REQUEST", `${path || "args"} must be ${expected}.`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const string =
  (options: { min?: number; max?: number; pattern?: RegExp } = {}): Parser<string> =>
  (value, path = "") => {
    if (typeof value !== "string") return fail(path, "a string");
    const max = options.max ?? 10_000;
    if (value.length > max) return fail(path, `at most ${max} characters`);
    if (options.min !== undefined && value.length < options.min) {
      return fail(path, `at least ${options.min} characters`);
    }
    if (options.pattern && !options.pattern.test(value)) {
      return fail(path, "well-formed");
    }
    return value;
  };

export const number =
  (options: { int?: boolean; min?: number; max?: number } = {}): Parser<number> =>
  (value, path = "") => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail(path, "a finite number");
    }
    if (options.int && !Number.isSafeInteger(value)) return fail(path, "an integer");
    if (options.min !== undefined && value < options.min) {
      return fail(path, `at least ${options.min}`);
    }
    if (options.max !== undefined && value > options.max) {
      return fail(path, `at most ${options.max}`);
    }
    return value;
  };

export const boolean = (): Parser<boolean> => (value, path = "") =>
  typeof value === "boolean" ? value : fail(path, "a boolean");

export const literal =
  <const T extends readonly (string | number | boolean)[]>(
    ...values: T
  ): Parser<T[number]> =>
  (value, path = "") =>
    values.includes(value as T[number])
      ? (value as T[number])
      : fail(path, `one of ${values.map((entry) => JSON.stringify(entry)).join(", ")}`);

export const optional =
  <T>(parser: Parser<T>): Parser<T | undefined> =>
  (value, path) =>
    value === undefined ? undefined : parser(value, path);

export const nullable =
  <T>(parser: Parser<T>): Parser<T | null> =>
  (value, path) =>
    value === null ? null : parser(value, path);

export const array =
  <T>(parser: Parser<T>, options: { max?: number } = {}): Parser<T[]> =>
  (value, path = "") => {
    if (!Array.isArray(value)) return fail(path, "an array");
    const max = options.max ?? 1_000;
    if (value.length > max) return fail(path, `at most ${max} items`);
    return value.map((entry, index) => parser(entry, `${path}[${index}]`));
  };

/** Any JSON value, bounded by its serialized size. */
export const json =
  (options: { maxBytes?: number } = {}): Parser<unknown> =>
  (value, path = "") => {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      return fail(path, "JSON");
    }
    if (text === undefined) return fail(path, "JSON");
    if (text.length > (options.maxBytes ?? 256 * 1024)) {
      return fail(path, "smaller");
    }
    return value;
  };

type Shape = Record<string, Parser<unknown>>;
type Parsed<S extends Shape> = {
  [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]>;
} & {
  [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<
    ReturnType<S[K]>,
    undefined
  >;
};

/** A record with exactly these keys; unknown keys are refused. */
export const object =
  <S extends Shape>(shape: S): Parser<Parsed<S>> =>
  (value, path = "") => {
    if (value === undefined && Object.keys(shape).length === 0) {
      return {} as Parsed<S>;
    }
    if (!isRecord(value)) return fail(path, "an object");
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        throw new RpcError("BAD_REQUEST", `${path ? `${path}.` : ""}${key} is not allowed.`);
      }
    }
    const result: Record<string, unknown> = {};
    for (const [key, parser] of Object.entries(shape)) {
      const parsed = parser(value[key], path ? `${path}.${key}` : key);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result as Parsed<S>;
  };

export const empty = (): Parser<Record<string, never>> =>
  object({}) as Parser<Record<string, never>>;
