declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatchObject(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeInstanceOf(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeInstanceOf(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toThrow(expected?: unknown): void;
    readonly rejects: PromiseMatchers;
    readonly resolves: PromiseMatchers;
  }
  interface PromiseMatchers {
    toThrow(expected?: unknown): Promise<void>;
    toBe(expected: unknown): Promise<void>;
    toEqual(expected: unknown): Promise<void>;
  }
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: (value: unknown) => Matchers;
  export const beforeEach: (fn: () => void | Promise<void>) => void;
  export const afterEach: (fn: () => void | Promise<void>) => void;

  export const mock: {
    module: (specifier: string, factory: () => unknown) => void;
    restore: () => void;
  };

  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K,
  ): { mockResolvedValue: (value: unknown) => unknown };
}
