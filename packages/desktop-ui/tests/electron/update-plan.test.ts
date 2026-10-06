import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyUpdate } from "@stella/desktop/electron/services/app-source/update-plan.js";
import {
  remoteMergeBrief,
  staleDraftBrief,
  undoBrief,
  upstreamMergeBrief,
} from "@stella/desktop/electron/services/app-source/app-source-briefs.js";

/**
 * The three cases pressing one of these buttons can be in, built as real
 * repositories.
 *
 * The one that matters is the middle one: a checkout whose history is not the
 * other side's ancestor, so the app cannot fast-forward it, but whose files
 * merge without a single conflict. That used to be reported as a conflict and
 * handed to an agent. Its sub-case — a local tree with no net difference from
 * the commit the two sides last shared, which is what a change and its revert
 * leave behind — has no merge judgement in it at all, and the plan says so.
 *
 * The same question is asked of the published app, of the owner's other
 * computer, and of a finished draft whose base moved, so it is asked of all
 * three here.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.stella.local",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.stella.local",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const commit = async (cwd: string, file: string, body: string, message: string) => {
  await fs.writeFile(path.join(cwd, file), body);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
};

const newRepo = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stella-update-plan-"));
  roots.push(cwd);
  git(cwd, ["init", "-q", "-b", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 1;\n", "U0");
  await commit(cwd, "shell.ts", "export const shell = 'plain';\n", "U0 shell");
  return cwd;
};

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
const plan = (cwd: string, ref = "refs/heads/upstream") =>
  classifyUpdate(cwd, head(cwd), ref);

/**
 * A finished draft of the user's, made against whatever `main` was when it
 * started and left on its own branch.
 */
const finishedDraft = async (
  cwd: string,
  name: string,
  file: string,
  body: string,
) => {
  git(cwd, ["checkout", "-q", "-b", `draft/${name}`]);
  await commit(cwd, file, body, `Draft: ${name}`);
  git(cwd, ["checkout", "-q", "main"]);
  return `refs/heads/draft/${name}`;
};

/**
 * An install's own branch: a change of the user's, their revert of it, and a
 * past update-merge. Upstream then moves on twice.
 */
const divergedInstall = async () => {
  const cwd = await newRepo();
  git(cwd, ["checkout", "-q", "-b", "main"]);
  await commit(cwd, "notes.md", "local notes\n", "A local change");
  git(cwd, ["revert", "--no-edit", "HEAD"]);
  git(cwd, ["checkout", "-q", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 2;\n", "U1");
  git(cwd, ["checkout", "-q", "main"]);
  git(cwd, ["merge", "--no-ff", "-q", "-m", "Merge update U1", "upstream"]);
  git(cwd, ["checkout", "-q", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 3;\n", "U2");
  await commit(cwd, "extra.ts", "export const extra = true;\n", "U3");
  git(cwd, ["checkout", "-q", "main"]);
  return cwd;
};

describe("classifyUpdate", () => {
  it("has nothing to do when upstream is already in", async () => {
    const cwd = await newRepo();
    git(cwd, ["checkout", "-q", "-b", "main"]);
    expect((await plan(cwd)).kind).toBe("none");
  });

  it("fast-forwards when the branch is upstream's ancestor", async () => {
    const cwd = await newRepo();
    git(cwd, ["branch", "main"]);
    await commit(cwd, "app.ts", "export const app = 2;\n", "U1");
    git(cwd, ["checkout", "-q", "main"]);
    const result = await plan(cwd);
    expect(result.kind).toBe("fast-forward");
    if (result.kind !== "fast-forward") return;
    expect(result.count).toBe(1);
    expect(result.subject).toBe("U1");
  });

  it("is clean with nothing to preserve when the local tree matches the merge base", async () => {
    const cwd = await divergedInstall();
    const result = await plan(cwd);
    expect(result.kind).toBe("clean");
    if (result.kind !== "clean") return;
    // Diverged by history alone: three local commits the upstream tip lacks.
    expect(git(cwd, ["rev-list", "--count", `${result.base}..HEAD`])).toBe("3");
    expect(result.localChanges).toBe(false);
    expect(result.identical).toBe(true);
    expect(result.tree).toBe(git(cwd, ["rev-parse", `${result.tip}^{tree}`]));
  });

  it("is clean but has something to preserve when local changes survive the merge", async () => {
    const cwd = await divergedInstall();
    await commit(cwd, "shell.ts", "export const shell = 'redesigned';\n", "Redesign");
    const result = await plan(cwd);
    expect(result.kind).toBe("clean");
    if (result.kind !== "clean") return;
    expect(result.localChanges).toBe(true);
    expect(result.identical).toBe(false);
  });

  it("names the conflicting files when both sides changed the same lines", async () => {
    const cwd = await divergedInstall();
    await commit(cwd, "app.ts", "export const app = 99;\n", "Local app change");
    const result = await plan(cwd);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts).toEqual(["app.ts"]);
    expect(result.localChanges).toBe(true);
  });

  it("advances the branch to upstream's tree without losing local history", async () => {
    const cwd = await divergedInstall();
    const before = await plan(cwd);
    expect(before.kind).toBe("clean");
    if (before.kind !== "clean") return;
    const at = head(cwd);
    const merged = git(cwd, [
      "commit-tree",
      before.tree,
      "-p",
      at,
      "-p",
      before.tip,
      "-m",
      "Merge the published Stella update",
    ]);
    git(cwd, ["merge", "--ff-only", merged]);
    expect(git(cwd, ["diff", "--name-only", "refs/heads/upstream"])).toBe("");
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
    expect(git(cwd, ["merge-base", "--is-ancestor", at, "HEAD"])).toBe("");
    expect((await plan(cwd)).kind).toBe("none");
  });
});

describe("classifyUpdate on a draft whose base moved", () => {
  it("fast-forwards a draft still based on the current version", async () => {
    const cwd = await newRepo();
    git(cwd, ["checkout", "-q", "-b", "main"]);
    const ref = await finishedDraft(cwd, "tidy", "tidy.ts", "export const a = 1;\n");
    expect((await plan(cwd, ref)).kind).toBe("fast-forward");
  });

  it("merges a stale draft that does not clash, with no agent needed", async () => {
    const cwd = await newRepo();
    git(cwd, ["checkout", "-q", "-b", "main"]);
    const ref = await finishedDraft(cwd, "tidy", "tidy.ts", "export const a = 1;\n");
    // The base moves under the draft, somewhere else in the tree.
    await commit(cwd, "other.ts", "export const other = 1;\n", "Moved on");
    const result = await plan(cwd, ref);
    expect(result.kind).toBe("clean");
    if (result.kind !== "clean") return;
    expect(result.localChanges).toBe(true);
    expect(result.identical).toBe(false);
  });

  it("names the clashing file when the base moved under the draft's own edit", async () => {
    const cwd = await newRepo();
    git(cwd, ["checkout", "-q", "-b", "main"]);
    const ref = await finishedDraft(
      cwd,
      "tidy",
      "app.ts",
      "export const app = 'draft';\n",
    );
    await commit(cwd, "app.ts", "export const app = 'moved on';\n", "Moved on");
    const result = await plan(cwd, ref);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts).toEqual(["app.ts"]);
  });
});

/**
 * The briefs replaced sentences the app typed into the chat on the user's
 * behalf. They must carry the state the app established — so no agent
 * re-derives it — and must never read as the user speaking.
 */
describe("agent briefs", () => {
  const clean = {
    kind: "clean" as const,
    tip: "1234567890abcdef1234567890abcdef12345678",
    count: 3,
    subject: "Upstream subject",
    base: "fedcba0987654321fedcba0987654321fedcba09",
    tree: "aaaa",
    identical: false,
    localChanges: true,
  };
  const conflict = {
    kind: "conflict" as const,
    tip: clean.tip,
    count: clean.count,
    subject: clean.subject,
    base: clean.base,
    conflicts: ["packages/desktop-ui/src/shell/ShellTopBar.tsx"],
    localChanges: true,
  };
  const head = "0000000000000000000000000000000000000000";

  const all = () => [
    upstreamMergeBrief(conflict, head),
    remoteMergeBrief(conflict, head, "refs/remotes/stella-fork/main"),
    staleDraftBrief(conflict, head, "tidy"),
    undoBrief({
      sha: clean.base,
      subject: "Redesign the shell",
      head,
      conflicts: ["packages/desktop-ui/src/shell/ShellTopBar.tsx"],
    }),
  ];

  it("never speaks as the user", () => {
    // The exact sentence that appeared in Rahul's chat as though he had typed
    // it, plus the shape of the others.
    for (const brief of all()) {
      expect(brief.prompt).not.toContain("Merge the changes from my other computer");
      expect(brief.prompt).not.toMatch(/\bmy (draft|other computer|changes)\b/);
      expect(brief.description.length).toBeGreaterThan(0);
    }
  });

  it("carries the state so nothing has to be re-derived", () => {
    for (const brief of [
      upstreamMergeBrief(conflict, head),
      remoteMergeBrief(conflict, head, "refs/remotes/stella-fork/main"),
      staleDraftBrief(conflict, head, "tidy"),
    ]) {
      expect(brief.prompt).toContain(conflict.tip);
      expect(brief.prompt).toContain(conflict.base);
      expect(brief.prompt).toContain(head);
      expect(brief.prompt).toContain(conflict.conflicts[0]!);
    }
  });

  it("says a failed check is a failed check, not a conflict", () => {
    const brief = upstreamMergeBrief(clean, head, "ERROR: Unexpected \"=\"");
    expect(brief.prompt).toContain("without a single conflict");
    expect(brief.prompt).toContain('ERROR: Unexpected "="');
  });

  it("tells the undo agent the user applies that one themselves", () => {
    const brief = undoBrief({
      sha: clean.base,
      subject: "Redesign the shell",
      head,
      conflicts: ["a.ts", "b.ts"],
    });
    expect(brief.prompt).toContain("they apply themselves");
    expect(brief.prompt).toContain("a.ts");
    expect(brief.prompt).toContain("b.ts");
  });
});
