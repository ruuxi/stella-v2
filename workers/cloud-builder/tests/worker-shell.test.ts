import { describe, expect, test } from "bun:test";
import { parse } from "just-bash";
import { analyzeWorkerShellScript } from "../src/worker-shell/eligibility.js";
import type {
  WorkerShellOutcome,
  WorkerShellRequest,
} from "../src/worker-shell/protocol.js";
import { missingFeature, runWorkerShell } from "../src/worker-shell/run.js";
import { createFakeShellWorld } from "./helpers/fake-shell-world.js";

const ROOT = "/workspace/world";

const request = (
  script: string,
  overrides: Partial<WorkerShellRequest> = {},
): WorkerShellRequest => ({
  script,
  root: ROOT,
  cwd: ROOT,
  env: { HOME: "/workspace/.stella-tool-home" },
  timeoutMs: 5_000,
  sandboxOnly: ["drive"],
  ...overrides,
});

const completed = (outcome: WorkerShellOutcome) => {
  if (outcome.kind !== "completed") {
    throw new Error(`expected completion, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

const fellBack = (outcome: WorkerShellOutcome) => {
  if (outcome.kind !== "fallback") {
    throw new Error(`expected fallback, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

describe("worker shell eligibility", () => {
  const verdict = (script: string) => analyzeWorkerShellScript(parse(script));

  test("admits ordinary text and file commands", () => {
    for (const script of [
      "cat a.txt | grep -v x | sort | uniq -c > out.txt",
      "for f in *.md; do wc -l \"$f\"; done",
      "f() { head -n 1 \"$1\"; }; f a.txt",
      "find . -name '*.ts' -exec cat {} \\;",
      "jq '.items | length' data.json",
      "echo $(ls) && printf '%s\\n' \"$HOME\"",
      "env LC_ALL=C sort a.txt",
      "set -euo pipefail; cat a.txt",
      "cat <<'EOF' > note.txt\nhello\nEOF",
    ]) {
      expect(verdict(script)).toEqual({ ok: true });
    }
  });

  test("refuses what only a real system can do", () => {
    const cases: Array<[string, string]> = [
      ["node build.js", "unsupported_command"],
      ["npm install && ls", "unsupported_command"],
      ["echo $(git status)", "unsupported_command"],
      ["./run.sh", "unsupported_command"],
      ["$tool --version", "unsupported_syntax"],
      ["sleep 5 &", "unsupported_syntax"],
      ["eval ls", "unsupported_command"],
      ["source env.sh", "unsupported_command"],
      ["curl https://example.com", "unsupported_command"],
      ["python3 -c 'print(1)'", "unsupported_command"],
    ];
    for (const [script, reason] of cases) {
      expect({ script, verdict: verdict(script) }).toMatchObject({
        script,
        verdict: { ok: false, reason },
      });
    }
  });

  test("refuses questions that would describe the lightweight shell", () => {
    for (const script of [
      "which node",
      "command -v jq",
      "type ls",
      "env",
      "set",
      "export -p",
      "declare -p",
      "hash -p ./x ls",
    ]) {
      expect(verdict(script).ok).toBe(false);
    }
  });

  test("refuses any way to make a later command resolve to a file", () => {
    for (const script of [
      "PATH=/workspace/world/bin ls",
      "export PATH=/x",
      "read PATH <<< /x",
      "printf -v PATH %s /x",
      "declare -n ref=PATH",
      "(( PATH = 1 ))",
      'export "$name"=1',
      "alias ls=cat",
    ]) {
      expect(verdict(script).ok).toBe(false);
    }
  });
});

describe("worker shell run", () => {
  test("runs pipelines, quoting, globbing and arithmetic over the world", async () => {
    const world = await createFakeShellWorld({
      "notes/b.txt": "beta\nalpha\nbeta\n",
      "notes/a.txt": "one\n",
      "data.json": '{"items":[1,2,3]}',
    });
    const outcome = completed(
      await runWorkerShell(
        request(
          [
            "sort notes/b.txt | uniq -c | sort -rn | head -1",
            "echo notes/*.txt",
            "echo \"a  b\" 'c $HOME' $HOME",
            "jq '.items | length' data.json",
            "echo $(( 6 * 7 ))",
          ].join("\n"),
        ),
        world.world,
      ),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(
      [
        // just-bash pads uniq -c counts to four columns; GNU uses seven.
        "   2 beta",
        "notes/a.txt notes/b.txt",
        "a  b c $HOME /workspace/.stella-tool-home",
        "3",
        "42",
        "",
      ].join("\n"),
    );
    expect(outcome.changes).toEqual({ entries: [], deleted: [] });
    expect(outcome.reads.paths).toContain("notes/b.txt");
    expect(outcome.reads.children).toContain("notes");
  });

  test("stages writes and reports them as one change set", async () => {
    const world = await createFakeShellWorld({
      "src/main.txt": "hello\n",
      "old.txt": "bye\n",
      "tmp/scratch.txt": "x",
    });
    const outcome = completed(
      await runWorkerShell(
        request(
          [
            "mkdir -p out/deep",
            "tr a-z A-Z < src/main.txt > out/deep/upper.txt",
            "echo more >> out/deep/upper.txt",
            "cp src/main.txt out/copy.txt",
            "mv old.txt out/renamed.txt",
            "rm -r tmp",
            "ln -s ../src/main.txt out/link.txt",
            "chmod 755 out/copy.txt",
            "cat out/deep/upper.txt out/link.txt",
          ].join("\n"),
        ),
        world.world,
      ),
    );
    expect(outcome.stdout).toBe("HELLO\nmore\nhello\n");
    // Nothing reached the world yet.
    expect(world.text("out/deep/upper.txt")).toBeNull();
    expect(world.text("old.txt")).toBe("bye\n");
    world.apply(outcome.changes);
    expect(world.text("out/deep/upper.txt")).toBe("HELLO\nmore\n");
    expect(world.text("out/copy.txt")).toBe("hello\n");
    expect(world.entry("out/copy.txt")?.mode).toBe(0o755);
    expect(world.text("out/renamed.txt")).toBe("bye\n");
    expect(world.entry("old.txt")).toBeUndefined();
    expect(world.entry("tmp")).toBeUndefined();
    expect(world.entry("tmp/scratch.txt")).toBeUndefined();
    expect(world.entry("out/link.txt")).toMatchObject({
      kind: "symlink",
      target: "../src/main.txt",
    });
    // Copies and renames of world files reference the existing blob.
    expect(world.calls.putBlob).toBe(1);
  });

  test("keeps UTF-8 and binary contents intact", async () => {
    const world = await createFakeShellWorld({
      "u.txt": "héllo 世界 😀\n",
      "bin.dat": new Uint8Array([0, 255, 128, 10, 1]),
    });
    const outcome = completed(
      await runWorkerShell(
        request("cat u.txt; cp bin.dat copy.dat; cat u.txt > u2.txt; wc -c < bin.dat"),
        world.world,
      ),
    );
    expect(outcome.stdout).toBe("héllo 世界 😀\n5\n");
    world.apply(outcome.changes);
    expect(world.text("u2.txt")).toBe("héllo 世界 😀\n");
    expect(world.entry("copy.dat")?.sha256).toBe(world.entry("bin.dat")?.sha256);
  });

  test("reports ordinary command errors as results, not fallbacks", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    const outcome = completed(
      await runWorkerShell(
        request("cat missing.txt; echo after; grep -q zzz a.txt"),
        world.world,
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("after\n");
    expect(outcome.stderr).toContain("missing.txt");
    expect(outcome.stderr).toContain("No such file or directory");
  });

  test("a mixed script falls back before any of it lands", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    const outcome = fellBack(
      await runWorkerShell(
        request("echo built > result.txt\nrm a.txt\nnode build.js"),
        world.world,
      ),
    );
    expect(outcome.reason).toBe("unsupported_command");
    expect(outcome.detail).toContain("node");
    // Refused at parse: nothing ran, nothing was uploaded.
    expect(world.calls.putBlob).toBe(0);
    expect(world.text("a.txt")).toBe("a\n");
    expect(world.entry("result.txt")).toBeUndefined();
  });

  test("allowed commands built at runtime still run", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n", "b.txt": "b\n" });
    const outcome = completed(
      await runWorkerShell(
        request(
          "printf 'a.txt\\nb.txt\\n' | xargs cat; find . -name 'a.txt' -exec wc -l {} \\;",
        ),
        world.world,
      ),
    );
    expect(outcome.stdout).toBe("a\nb\n1 ./a.txt\n");
  });

  test("a command built at runtime is analyzed before it runs", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    const outcome = fellBack(
      await runWorkerShell(
        request(
          "echo staged > staged.txt\nprintf 'build.js\\n' | xargs node\necho after > after.txt",
        ),
        world.world,
      ),
    );
    expect(outcome.reason).toBe("unsupported_command");
    expect(world.calls.putBlob).toBe(0);
    expect(world.entry("staged.txt")).toBeUndefined();
  });

  test("names a just-bash gap from a command's own stderr", () => {
    expect(
      missingFeature("awk: system() is not supported - shell execution not allowed\n"),
    ).toBe("awk: system() is not supported - shell execution not allowed");
    expect(missingFeature("sed: unrecognized option '--debug'\n")).toBe(
      "sed: unrecognized option '--debug'",
    );
    expect(missingFeature("grep: invalid option -- 'P'\n")).not.toBeNull();
    expect(missingFeature("cat: missing.txt: No such file or directory\n")).toBeNull();
    expect(missingFeature(undefined)).toBeNull();
  });

  test("paths outside the workspace go to the sandbox", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    for (const script of [
      "cat /etc/passwd",
      "echo x > /tmp/out.txt",
      "ls /",
      "cat ~/.bashrc",
      "cd /tmp && ls",
    ]) {
      const outcome = fellBack(
        await runWorkerShell(request(`echo first > first.txt\n${script}`), world.world),
      );
      expect({ script, reason: outcome.reason }).toEqual({
        script,
        reason: "outside_workspace",
      });
    }
    expect(world.calls.putBlob).toBe(0);
  });

  test("a link out of the workspace goes to the sandbox", async () => {
    const world = await createFakeShellWorld({
      "etc-link": { symlink: "/etc/passwd" },
      "inside-link": { symlink: "/workspace/world/a.txt" },
      "a.txt": "a\n",
    });
    expect(
      completed(await runWorkerShell(request("cat inside-link"), world.world))
        .stdout,
    ).toBe("a\n");
    expect(
      fellBack(await runWorkerShell(request("cat etc-link"), world.world))
        .reason,
    ).toBe("outside_workspace");
  });

  test("the drive is left to the sandbox that synchronizes it", async () => {
    const world = await createFakeShellWorld({ "drive/report.md": "old copy\n" });
    const outcome = fellBack(
      await runWorkerShell(request("cat drive/report.md"), world.world),
    );
    expect(outcome.reason).toBe("sandbox_only_path");
    expect(
      fellBack(await runWorkerShell(request("grep -r copy ."), world.world))
        .reason,
    ).toBe("sandbox_only_path");
    // Listing the root names the drive without reading it.
    expect(
      completed(await runWorkerShell(request("ls"), world.world)).stdout,
    ).toBe("drive\n");
  });

  test("hard links are refused rather than faked", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    const outcome = fellBack(
      await runWorkerShell(request("ln a.txt b.txt"), world.world),
    );
    expect(outcome.reason).toBe("unsupported_filesystem_operation");
  });

  test("limits stop the run before anything is committed", async () => {
    const world = await createFakeShellWorld({ "a.txt": "a\n" });
    expect(
      fellBack(
        await runWorkerShell(
          request("seq 1 100000 > big.txt"),
          world.world,
          { limits: { stagedBytes: 1_000 } },
        ),
      ).reason,
    ).toBe("resource_limit");
    expect(
      fellBack(
        await runWorkerShell(
          request("for i in $(seq 1 50); do cat a.txt > f$i.txt; done"),
          world.world,
          { limits: { stagedFiles: 10 } },
        ),
      ).reason,
    ).toBe("resource_limit");
    expect(
      fellBack(
        await runWorkerShell(request("cat a.txt"), world.world, {
          limits: { fileBytes: 1 },
        }),
      ).reason,
    ).toBe("resource_limit");
    expect(world.calls.putBlob).toBe(0);
  });

  test("a command that outlives its budget falls back", async () => {
    const world = await createFakeShellWorld({});
    const outcome = fellBack(
      await runWorkerShell(
        request("echo staged > staged.txt; sleep 3; echo late", {
          timeoutMs: 200,
        }),
        world.world,
      ),
    );
    expect(outcome.reason).toBe("timeout");
    expect(world.calls.putBlob).toBe(0);
  });

  test("cancellation stops the run without a change set", async () => {
    const world = await createFakeShellWorld({});
    const outcome = fellBack(
      await runWorkerShell(
        request("echo staged > staged.txt; sleep 3"),
        world.world,
        { cancelled: Promise.resolve() },
      ),
    );
    expect(outcome.detail).toContain("cancelled");
    expect(world.calls.putBlob).toBe(0);
  });

  test("runs in a workdir and refuses one that is not a real directory", async () => {
    const world = await createFakeShellWorld({
      "proj/a.txt": "a\n",
      "proj-link": { symlink: "proj" },
    });
    expect(
      completed(
        await runWorkerShell(
          request("pwd; cat a.txt", { cwd: `${ROOT}/proj` }),
          world.world,
        ),
      ).stdout,
    ).toBe(`${ROOT}/proj\na\n`);
    for (const cwd of [`${ROOT}/missing`, `${ROOT}/proj-link`]) {
      expect(
        fellBack(await runWorkerShell(request("ls", { cwd }), world.world))
          .reason,
      ).toBe("unsupported_filesystem_operation");
    }
  });

  test("scripts larger than the source bound fall back", async () => {
    const world = await createFakeShellWorld({});
    expect(
      fellBack(
        await runWorkerShell(request(`echo ${"x".repeat(300_000)}`), world.world),
      ).reason,
    ).toBe("resource_limit");
  });
});
