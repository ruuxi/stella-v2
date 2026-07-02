/**
 * Minimal ambient types for `bun:test`, just enough for the pure-function
 * tests in this folder to typecheck without pulling `@types/bun` into the
 * Expo app. Run the tests with `bun test` from `mobile/`.
 */
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatchObject(expected: unknown): void;
    toBeNull(): void;
    toBeGreaterThan(expected: number): void;
    toThrow(expected?: unknown): void;
  }
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: (value: unknown) => Matchers;
}
