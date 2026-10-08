import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

/**
 * The worker shell against real WorldStore RPC in local workerd: the generated
 * bundle (with its dispatcher hooks) runs in a Worker Loader isolate, reads
 * the world through the `ctx.exports` loopback, and the host commits through
 * `WorldStore.commitShell`. The fixture's ladder only records what reached the
 * sandbox, so every assertion about the world is about what the shell did.
 */

type ExecResponse = {
  result: {
    outcome: { kind: "ok"; text: string } | { kind: "error"; message: string };
    details: Record<string, unknown> | null;
  };
  sandboxCalls: Array<{ toolName: string; params: { cmd: string } }>;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
  attached: boolean;
  elapsedMs: number;
};

let dev: WorkerdDev;

beforeAll(async () => {
  dev = await startWorkerdDev({
    config: "tests/fixtures/worker-shell-workerd.wrangler.jsonc",
    prefix: "stella-worker-shell-workerd-",
  });
}, 60_000);

afterAll(async () => {
  await dev?.stop();
});

const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  const response = await dev.requestJson(path, body);
  if (response.status !== 200) {
    throw new Error(`${path} failed: ${JSON.stringify(response.body)}`);
  }
  return response.body as T;
};

const seed = (world: string, files: Record<string, unknown>) =>
  post("/seed", { world, files });

const exec = (
  world: string,
  cmd: string,
  extra: Record<string, unknown> = {},
) => post<ExecResponse>("/exec", { world, cmd, ...extra });

const read = async (world: string, path: string) =>
  (
    await post<{ text: string | null; entry: Record<string, unknown> | null }>(
      "/read",
      { world, path },
    )
  );

const output = (response: ExecResponse): string => {
  if (response.result.outcome.kind !== "ok") {
    throw new Error(`tool error: ${response.result.outcome.message}`);
  }
  const text = response.result.outcome.text;
  return text.slice(text.indexOf("Output:\n") + "Output:\n".length);
};

const fallbackReason = (response: ExecResponse): unknown =>
  response.events.find((event) => event.kind === "worker_shell_fallback")
    ?.payload.reason;

describe("worker shell in workerd", () => {
  test("runs ordinary commands and commits their writes to the WorldStore", async () => {
    await seed("ordinary", {
      "notes/b.txt": "beta\nalpha\nbeta\n",
      "notes/a.txt": "one two\n",
      "data.json": JSON.stringify({ items: [1, 2, 3], name: "stella" }),
    });
    const response = await exec(
      "ordinary",
      [
        "sort notes/b.txt | uniq | tr a-z A-Z",
        "jq -r '.name + \" \" + (.items | length | tostring)' data.json",
        "echo notes/*.txt",
        "awk '{ print $2 }' notes/a.txt",
        "sed 's/beta/gamma/' notes/b.txt | head -1",
        "grep -c beta notes/b.txt",
        "printf '%s|%s\\n' \"a  b\" 'c $d'",
        "mkdir -p out && cat notes/*.txt > out/all.txt && wc -l < out/all.txt",
      ].join("\n"),
    );
    expect(response.sandboxCalls).toEqual([]);
    expect(response.attached).toBe(false);
    expect(output(response)).toBe(
      [
        "ALPHA",
        "BETA",
        "stella 3",
        "notes/a.txt notes/b.txt",
        "two",
        "gamma",
        "2",
        "a  b|c $d",
        "4",
        "",
      ].join("\n"),
    );
    expect(response.result.details).toMatchObject({
      runtime: "worker_shell",
      exit_code: 0,
    });
    expect((await read("ordinary", "out/all.txt")).text).toBe(
      "one two\nbeta\nalpha\nbeta\n",
    );
  });

  test("reports a failing command as its result", async () => {
    await seed("errors", { "a.txt": "a\n" });
    const response = await exec("errors", "cat missing.txt; grep -q zzz a.txt");
    expect(response.sandboxCalls).toEqual([]);
    const text = (response.result.outcome as { text: string }).text;
    expect(text).toContain("Process exited with code 1");
    expect(text).toContain("missing.txt: No such file or directory");
  });

  test("a mixed script runs once in the sandbox and leaves no shell effects", async () => {
    await seed("mixed", { "counter.txt": "0\n" });
    const response = await exec(
      "mixed",
      "echo 1 >> counter.txt\nrm counter.txt\nnpm run build",
    );
    expect(response.sandboxCalls).toHaveLength(1);
    expect(fallbackReason(response)).toBe("unsupported_command");
    expect((await read("mixed", "counter.txt")).text).toBe("0\n");
  });

  test("gaps found while running hand over without their earlier effects", async () => {
    await seed("gaps", {
      "counter.txt": "0\n",
      "evil/cat": { mode: 0o755, text: "echo pwned > pwned.txt\n" },
    });
    const cases: Array<[string, string]> = [
      // awk's system() is not implemented by just-bash.
      [`awk 'BEGIN { system("node -v") }'`, "unsupported_command"],
      // just-bash's xargs has no -I.
      ["echo a | xargs -I{} echo {}", "unsupported_command"],
      // PATH set at runtime, past the analysis, to a workspace program.
      [
        "unset PATH; : ${PATH:=/workspace/world/evil}; cat counter.txt",
        "unsupported_command",
      ],
      // A name no registered command answers.
      ["unset PATH; : ${PATH:=/workspace/world}; ls", "unsupported_command"],
      // An interpreter limit ends execution early.
      ["seq 1 2000000 | tail -1", "resource_limit"],
    ];
    for (const [script, reason] of cases) {
      const response = await exec("gaps", `echo 1 >> counter.txt\n${script}`);
      expect({ script, reason: fallbackReason(response) }).toEqual({
        script,
        reason,
      });
      expect(response.sandboxCalls).toHaveLength(1);
    }
    expect((await read("gaps", "counter.txt")).text).toBe("0\n");
    expect((await read("gaps", "pwned.txt")).entry).toBeNull();
  });

  test("the drive, links out and outside paths are the sandbox's", async () => {
    await seed("boundaries", {
      "drive/report.md": "stale copy\n",
      "etc-link": { symlink: "/etc/passwd" },
    });
    for (const [script, reason] of [
      ["cat drive/report.md", "sandbox_only_path"],
      ["cat etc-link", "outside_workspace"],
      ["cat /etc/hostname", "outside_workspace"],
      ["echo x > /tmp/scratch", "outside_workspace"],
      ["ls ~/.cache", "sandbox_only_path"],
      ["ls $XDG_CACHE_HOME", "outside_workspace"],
    ] as const) {
      const response = await exec("boundaries", script);
      expect({ script, reason: fallbackReason(response) }).toEqual({
        script,
        reason,
      });
    }
  });

  test("a cancelled call returns promptly and changes nothing", async () => {
    await seed("cancel", {});
    const response = await exec("cancel", "echo c > cancelled.txt; sleep 5", {
      abortAfterMs: 300,
    });
    expect(response.result.outcome).toEqual({
      kind: "error",
      message: "The command was cancelled before it changed the workspace.",
    });
    expect(response.elapsedMs).toBeLessThan(2_000);
    expect(response.sandboxCalls).toEqual([]);
    expect((await read("cancel", "cancelled.txt")).entry).toBeNull();
  });

  test("a command that outlives its yield window runs in the sandbox instead", async () => {
    await seed("slow", {});
    const response = await exec("slow", "echo t > timed.txt; sleep 5", {
      params: { yield_time_ms: 1_000 },
    });
    expect(fallbackReason(response)).toBe("timeout");
    expect(response.sandboxCalls).toHaveLength(1);
    expect((await read("slow", "timed.txt")).entry).toBeNull();
  });

  test("a write that lands mid-run makes the command run again, not commit stale work", async () => {
    await seed("race", { "a.txt": "v1\n" });
    const running = exec("race", "cat a.txt > b.txt; sleep 1; cat b.txt", {
      params: { yield_time_ms: 5_000 },
    });
    await Bun.sleep(400);
    await seed("race", { "a.txt": "v2\n" });
    const response = await running;
    expect(response.sandboxCalls).toEqual([]);
    expect(output(response)).toBe("v2\n");
    expect((await read("race", "b.txt")).text).toBe("v2\n");
  });

  test("once the sandbox attaches, every later command runs there", async () => {
    await seed("attach", { "a.txt": "a\n" });
    const response = await post<{ outputs: string[]; sandboxCalls: string[] }>(
      "/sequence",
      { world: "attach", commands: ["cat a.txt", "git status", "cat a.txt"] },
    );
    expect(response.outputs[0]).toContain("Output:\na\n");
    expect(response.sandboxCalls).toEqual(["git status", "cat a.txt"]);
    const attached = await exec("attach", "cat a.txt", { attached: true });
    expect(attached.sandboxCalls).toHaveLength(1);
  });

  test("tty and write_stdin shapes never reach the shell", async () => {
    await seed("tty", {});
    const response = await exec("tty", "ls", { params: { tty: true } });
    expect(response.sandboxCalls).toHaveLength(1);
    expect(response.events).toEqual([]);
  });
});
