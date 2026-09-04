import { describe, expect, test } from "bun:test";
import { attachAgentWorld } from "../src/build-session/container-turn.js";
import { WorldSqlStore } from "../src/world/store.js";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
};

const execution = () => ({
  cancellation: {
    aborted: false,
    reason: undefined,
    abort: () => undefined,
    sleep: async () => undefined,
  },
  signal: new AbortController().signal,
  assertActive: () => undefined,
});

const turn = (turnId: string) =>
  ({
    kind: "agent",
    turnId,
    threadId: `thread-${turnId}`,
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    attemptGeneration: 1,
  }) as never;

const result = { success: true, exitCode: 0, stdout: "", stderr: "" };

const harness = (options: {
  createSession: () => Promise<unknown>;
  head: () => Promise<{ manifestId: string; revision: number }>;
}) => {
  const calls: string[] = [];
  const commands: string[] = [];
  const deleted: string[] = [];
  const session = {
    exec: async (command: string) => {
      calls.push(
        command.includes("/internal/worlds/") ? "materialize" : "normalize",
      );
      commands.push(command);
      return result;
    },
  };
  const sandbox = {
    createSession: async () => {
      calls.push("create");
      return await options.createSession();
    },
    deleteSession: async (id: string) => {
      calls.push("delete");
      deleted.push(id);
    },
  };
  const host = {
    assertAgentExecutionActive: async () => undefined,
    env: {
      BUILDER_SERVICE_SECRET: "s".repeat(32),
      CLOUD_BUILDER_PUBLIC_URL: "https://builder.test/",
      WORLDS: {
        getByName: () => ({
          head: async () => {
            calls.push("head");
            return await options.head();
          },
        }),
      },
    },
    confirmAgentTurnStateRestore: async () => undefined,
  };
  return { calls, commands, deleted, host, sandbox, session };
};

const attach = (
  target: ReturnType<typeof harness>,
  turnId = "turn-1",
  sessionId = `agent-run-${turnId}`,
) =>
  attachAgentWorld(target.host as never, {
    turn: turn(turnId),
    execution: execution(),
    sandbox: target.sandbox as never,
    size: "small",
    turnStateThreadRestoreConfirmationRequired: false,
    history: [],
    commandTimeoutMs: 60_000,
    sessionId,
  });

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
};

describe("agent world startup", () => {
  test("real store refuses a stale live head and exports the current head consistently", async () => {
    const storage = openSqlStorageFake();
    try {
      const world = new WorldSqlStore(
        storage.sql,
        {} as R2Bucket,
        () => 1_700_000_000_000,
      );
      world.initialize();
      await world.writeFile("before.txt", new TextEncoder().encode("before"));
      const stale = await world.head();

      await world.checkpoint({ historyCursor: `v1:${"1".repeat(64)}` });
      await world.writeFile("after.txt", new TextEncoder().encode("after"));

      expect(() => world.exportTar(stale.manifestId)).toThrow(
        `World manifest not found: ${stale.manifestId}`,
      );

      const current = await world.head();
      const exported = world.exportTar(current.manifestId);
      const archive = new TextDecoder().decode(
        await new Response(exported.body).arrayBuffer(),
      );
      expect(exported.revision).toBe(current.revision);
      expect(archive).toContain("before.txt");
      expect(archive).toContain("after.txt");
    } finally {
      storage.close();
    }
  });

  test("cold provisioning finishes before the live world head is read", async () => {
    const create = deferred<unknown>();
    const target = harness({
      createSession: async () => await create.promise,
      head: async () => ({ manifestId: "a".repeat(64), revision: 7 }),
    });

    const attaching = attach(target);
    await waitFor(() => target.calls.includes("create"));
    // Moving this mutable head read ahead of provisioning widens the known
    // checkpoint+write race in WorldStore, so it must remain serial for now.
    expect(target.calls).not.toContain("head");

    create.resolve(target.session);
    await attaching;
    expect(target.calls.indexOf("normalize")).toBeLessThan(
      target.calls.indexOf("head"),
    );
    expect(target.calls.indexOf("head")).toBeLessThan(
      target.calls.indexOf("materialize"),
    );
  });

  test("a warm retry replaces an existing session before restoring", async () => {
    const target = harness({
      createSession: async () => target.session,
      head: async () => ({ manifestId: "b".repeat(64), revision: 8 }),
    });
    let creates = 0;
    target.sandbox.createSession = async () => {
      target.calls.push("create");
      creates += 1;
      if (creates === 1) throw new Error("session already exists");
      return target.session;
    };

    await attach(target);

    expect(creates).toBe(2);
    expect(target.deleted).toEqual(["agent-run-turn-1"]);
    expect(target.calls.indexOf("delete")).toBeLessThan(
      target.calls.indexOf("materialize"),
    );
  });

  test("metadata failure cleans the provisioned session", async () => {
    const target = harness({
      createSession: async () => target.session,
      head: async () => {
        throw new Error("world head unavailable");
      },
    });

    await expect(attach(target)).rejects.toThrow("world head unavailable");

    expect(target.deleted).toEqual(["agent-run-turn-1"]);
    expect(target.calls).not.toContain("materialize");
  });
});
