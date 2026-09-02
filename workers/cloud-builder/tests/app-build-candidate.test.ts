import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const { BuildSession } = await import("../src/index.js");
mock.restore();

const source = await Bun.file(
  new URL("../src/index.ts", import.meta.url),
).text();

/** The body of one private BuildSession method, by brace depth. */
const methodBody = (name: string): string => {
  const start = source.indexOf(`  private async ${name}(`);
  if (start === -1) throw new Error(`Missing BuildSession method: ${name}`);
  let parens = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parens += 1;
    else if (source[cursor] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const open = source.indexOf("{", cursor);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`Unbalanced braces in BuildSession method: ${name}`);
};

const APP_TURN_BODY = methodBody("runTurn");

describe("app build lane", () => {
  test("keeps remote authority I/O outside the concurrency gate", () => {
    expect(APP_TURN_BODY).toContain("APP_TURN_ADMISSION_CLAIM_KEY");
    expect(APP_TURN_BODY).toContain("assertTurnWritable");
    expect(APP_TURN_BODY).toContain("assertAppTurnIdentity");
    expect(APP_TURN_BODY).not.toContain("blockConcurrencyWhile");
  });

  test("never routes traffic to the build it just produced", () => {
    expect(APP_TURN_BODY).toContain("APP_BUILDS.put");
    expect(APP_TURN_BODY).toContain("callbackBody");
    expect(APP_TURN_BODY).not.toContain("APP_ROUTES");
  });

  test("hands Convex a callback with no activation decision in it", () => {
    expect(APP_TURN_BODY).not.toContain("autoActivate");
  });

  test("has no route to roll back when a build turn is cleaned up", async () => {
    const values = new Map<string, unknown>([
      ["transientBuild:turn-1", "builds/ownerhash/build-1"],
    ]);
    const deleted: string[] = [];
    const swept: string[] = [];
    const instance = Object.create(BuildSession.prototype) as Record<
      string,
      unknown
    >;
    Object.assign(instance, {
      ctx: {
        storage: {
          get: async <T>(key: string) => values.get(key) as T | undefined,
          delete: async (key: string | string[]) => {
            for (const entry of Array.isArray(key) ? key : [key]) {
              deleted.push(entry);
              values.delete(entry);
            }
            return true;
          },
        },
      },
      env: {
        APP_BUILDS: {
          list: async ({ prefix }: { prefix: string }) => {
            swept.push(prefix);
            return { objects: [], truncated: false };
          },
          delete: async () => undefined,
        },
        get APP_ROUTES(): never {
          throw new Error("A build turn must not touch the app route store.");
        },
      },
    });
    const cleanup = (
      BuildSession.prototype as unknown as Record<string, unknown>
    )["cleanupTransientWrites"] as (
      this: Record<string, unknown>,
      turn: { turnId: string },
    ) => Promise<void>;

    await cleanup.call(instance, { turnId: "turn-1" });

    expect(swept).toEqual(["builds/ownerhash/build-1/"]);
    expect(deleted).toEqual(["transientBuild:turn-1"]);
  });
});
