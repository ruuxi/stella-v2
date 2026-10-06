import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What each button on a change to Stella actually does, driven through the
 * real service against real repositories.
 *
 * This is the decision table the fabricated chat messages used to stand in
 * for. Every one of these presses used to either refuse outright or type a
 * sentence into Rahul's chat as though he had asked for it; "Merge the
 * changes from my other computer." appeared in his transcript for a button he
 * pressed. So what is asserted here is: which presses apply by themselves,
 * which reach an agent, that the ones that reach an agent send a brief and
 * not a user turn, and that nothing is half-applied when they do.
 *
 * The build check itself is stubbed — it is verified against the real tree
 * elsewhere — so these tests can assert *whether* it runs, which is where
 * upstream and the fork deliberately differ.
 */

const gate = vi.hoisted(() => ({
  check: vi.fn(async () => ({ ok: true }) as { ok: boolean; output?: string }),
}));

vi.mock("electron", () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), getPath: () => os.tmpdir() },
}));

vi.mock(
  "@stella/desktop/electron/services/app-source/update-gate.js",
  () => ({ checkMergedUpdate: gate.check }),
);

const { AppSourceService } = await import(
  "@stella/desktop/electron/services/app-source/app-source-service.js"
);
type Service = InstanceType<typeof AppSourceService>;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  gate.check.mockReset();
  gate.check.mockImplementation(async () => ({ ok: true }));
});

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const commit = async (cwd: string, file: string, body: string, message: string) => {
  await fs.writeFile(path.join(cwd, file), body);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

const dispatched: { description: string; prompt: string }[] = [];

const build = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stella-take-"));
  roots.push(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@test.stella.local"]);
  await commit(cwd, "app.ts", "export const app = 1;\n", "Base");
  await commit(cwd, "shell.ts", "export const shell = 'plain';\n", "Base shell");
  dispatched.length = 0;
  const swapped: string[][] = [];
  const service = new AppSourceService({
    stellaAppDir: cwd,
    broadcast: () => {},
    isAnyWindowVisible: () => false,
    requestRuntimeRestart: () => {},
    applyRendererChanges: (paths) => {
      swapped.push(paths);
      return undefined;
    },
    relaunch: () => {},
    hasConnectedAccount: () => false,
    getBackendUrl: () => null,
    getAuthToken: async () => null,
    log: () => {},
    updateScratchDir: path.join(cwd, ".scratch"),
    dispatchAgentBrief: async (brief) => {
      dispatched.push(brief);
    },
  });
  return { cwd, service, swapped };
};

/** Pretend the fork is tracked, as a successful sync would leave it. */
const trackFork = (service: Service, branch: string) => {
  (service as unknown as { forkBranch: string | null }).forkBranch = branch;
};
const trackUpstream = (service: Service) => {
  (service as unknown as { upstreamTracked: boolean }).upstreamTracked = true;
};

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
const tree = (cwd: string, rev: string) => git(cwd, ["rev-parse", `${rev}^{tree}`]);

/** The state as a client receives it: published, not mid-read. */
const published = async (service: Service) => {
  await service.refresh();
  return service.getState();
};

/**
 * Another computer's branch, diverged from this one: each side has a commit
 * the other lacks, and they do not touch the same file.
 */
const divergedFork = async (cwd: string) => {
  const base = head(cwd);
  git(cwd, ["checkout", "-q", "-b", "other", base]);
  const tip = await commit(cwd, "phone.ts", "export const phone = 1;\n", "On the laptop");
  git(cwd, ["checkout", "-q", "main"]);
  git(cwd, ["update-ref", "refs/remotes/stella-fork/main", tip]);
  git(cwd, ["branch", "-D", "other"]);
  await commit(cwd, "desk.ts", "export const desk = 1;\n", "On the desktop");
  return tip;
};

describe("taking changes from another computer", () => {
  it("applies a diverged merge that is clean, with no agent and no question", async () => {
    const { cwd, service } = await build();
    const tip = await divergedFork(cwd);
    trackFork(service, "main");
    const before = head(cwd);

    const result = await service.applyRemote();

    expect(result).toEqual({ ok: true });
    expect(dispatched).toEqual([]);
    expect(git(cwd, ["merge-base", "--is-ancestor", before, "HEAD"])).toBe("");
    expect(git(cwd, ["merge-base", "--is-ancestor", tip, "HEAD"])).toBe("");
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
    // Both computers' work is in the result.
    expect(git(cwd, ["ls-tree", "--name-only", "HEAD"]).split("\n")).toEqual(
      expect.arrayContaining(["desk.ts", "phone.ts"]),
    );
  });

  it("checks the merge even when nothing of this computer's survives it", async () => {
    const { cwd, service } = await build();
    // This computer has nothing of its own: the merge result is the fork's
    // tree exactly. Upstream would skip the check here; the fork must not,
    // because no published build ever produced that tree.
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "other", base]);
    const tip = await commit(cwd, "phone.ts", "export const phone = 1;\n", "Elsewhere");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-fork/main", tip]);
    git(cwd, ["branch", "-D", "other"]);
    await commit(cwd, "note.md", "x\n", "Local");
    git(cwd, ["revert", "--no-edit", "HEAD"]);
    trackFork(service, "main");

    const result = await service.applyRemote();

    expect(result).toEqual({ ok: true });
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(tree(cwd, "HEAD")).toBe(tree(cwd, tip));
  });

  it("sends a brief, not a chat message, when it genuinely conflicts", async () => {
    const { cwd, service } = await build();
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "other", base]);
    const tip = await commit(cwd, "app.ts", "export const app = 'phone';\n", "Elsewhere");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-fork/main", tip]);
    git(cwd, ["branch", "-D", "other"]);
    await commit(cwd, "app.ts", "export const app = 'desk';\n", "Here");
    trackFork(service, "main");
    const before = head(cwd);

    const result = await service.applyRemote();

    expect(result).toEqual({ ok: true, background: true });
    expect(head(cwd)).toBe(before);
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
    expect(dispatched).toHaveLength(1);
    const brief = dispatched[0]!;
    expect(brief.prompt).toContain("app.ts");
    expect(brief.prompt).toContain(tip);
    expect(brief.prompt).not.toMatch(/\bmy other computer\b/);
    // The user is told nothing about why; the state only says it is running.
    expect((await published(service)).update).toEqual({ state: "merging" });
  });

  it("does not put a second agent on a merge already under way", async () => {
    const { cwd, service } = await build();
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "other", base]);
    const tip = await commit(cwd, "app.ts", "export const app = 'phone';\n", "Elsewhere");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-fork/main", tip]);
    git(cwd, ["branch", "-D", "other"]);
    await commit(cwd, "app.ts", "export const app = 'desk';\n", "Here");
    trackFork(service, "main");

    await service.applyRemote();
    // The agent's draft now exists; pressing again must not start another.
    git(cwd, ["branch", `draft/update-${tip.slice(0, 12)}`, "HEAD"]);
    await service.applyRemote();

    expect(dispatched).toHaveLength(1);
  });
});

describe("taking the published update", () => {
  it("skips the check when the result is upstream's tree exactly", async () => {
    const { cwd, service } = await build();
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "up", base]);
    const tip = await commit(cwd, "new.ts", "export const n = 1;\n", "Upstream moved");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-upstream/main", tip]);
    git(cwd, ["branch", "-D", "up"]);
    await commit(cwd, "note.md", "x\n", "Local");
    git(cwd, ["revert", "--no-edit", "HEAD"]);
    trackUpstream(service);

    const result = await service.applyUpstream();

    expect(result).toEqual({ ok: true });
    expect(gate.check).not.toHaveBeenCalled();
    expect(tree(cwd, "HEAD")).toBe(tree(cwd, tip));
  });

  it("goes to an agent when a clean merge does not build", async () => {
    const { cwd, service } = await build();
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "up", base]);
    const tip = await commit(cwd, "new.ts", "export const n = 1;\n", "Upstream moved");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-upstream/main", tip]);
    git(cwd, ["branch", "-D", "up"]);
    await commit(cwd, "mine.ts", "export const m = 1;\n", "Mine");
    trackUpstream(service);
    gate.check.mockImplementation(async () => ({
      ok: false,
      output: 'ERROR: Could not resolve "gone"',
    }));
    const before = head(cwd);

    const result = await service.applyUpstream();

    expect(result).toEqual({ ok: true, background: true });
    expect(head(cwd)).toBe(before);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.prompt).toContain("without a single conflict");
    expect(dispatched[0]!.prompt).toContain('Could not resolve "gone"');
  });
});

describe("taking an ordinary finished draft", () => {
  it("fast-forwards without building anything", async () => {
    const { cwd, service } = await build();
    git(cwd, ["checkout", "-q", "-b", "draft/tidy"]);
    const tip = await commit(cwd, "tidy.ts", "export const d = 1;\n", "Tidy the shell");
    git(cwd, ["checkout", "-q", "main"]);

    const result = await service.applyDraft("tidy");

    expect(result).toEqual({ ok: true });
    // A draft still based on the current version is a fast-forward: adding a
    // worktree and a build to every ordinary apply would be a cost for
    // nothing, and a reason for them to start failing.
    expect(gate.check).not.toHaveBeenCalled();
    expect(head(cwd)).toBe(tip);
    expect(dispatched).toEqual([]);
  });
});

describe("taking a draft whose base moved", () => {
  const staleDraft = async (cwd: string, draftFile: string, mainFile: string) => {
    git(cwd, ["checkout", "-q", "-b", "draft/tidy"]);
    const tip = await commit(cwd, draftFile, "export const d = 1;\n", "Tidy the shell");
    git(cwd, ["checkout", "-q", "main"]);
    await commit(cwd, mainFile, "export const m = 2;\n", "Main moved on");
    return tip;
  };

  it("merges and applies it, keeping the change's own subject", async () => {
    const { cwd, service } = await build();
    const tip = await staleDraft(cwd, "tidy.ts", "other.ts");
    const before = head(cwd);

    const result = await service.applyDraft("tidy");

    expect(result).toEqual({ ok: true });
    expect(dispatched).toEqual([]);
    expect(git(cwd, ["merge-base", "--is-ancestor", tip, "HEAD"])).toBe("");
    expect(git(cwd, ["merge-base", "--is-ancestor", before, "HEAD"])).toBe("");
    // The chat's card and the recent list name the change, not "Merge".
    expect(git(cwd, ["log", "-1", "--format=%s", "HEAD"])).toBe("Tidy the shell");
    // The draft is spent.
    expect(
      spawnSync("git", ["rev-parse", "--verify", "refs/heads/draft/tidy"], { cwd })
        .status,
    ).not.toBe(0);
  });

  it("sends a brief and leaves the draft alone when it genuinely conflicts", async () => {
    const { cwd, service } = await build();
    git(cwd, ["checkout", "-q", "-b", "draft/tidy"]);
    const tip = await commit(cwd, "app.ts", "export const app = 'draft';\n", "Tidy");
    git(cwd, ["checkout", "-q", "main"]);
    await commit(cwd, "app.ts", "export const app = 'moved';\n", "Main moved on");
    const before = head(cwd);

    const result = await service.applyDraft("tidy");

    expect(result).toEqual({ ok: true, background: true });
    expect(head(cwd)).toBe(before);
    expect(git(cwd, ["rev-parse", "refs/heads/draft/tidy"])).toBe(tip);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.prompt).toContain("draft/tidy");
    expect(dispatched[0]!.prompt).not.toMatch(/\bmy draft\b/);
  });
});

/**
 * Three of these four buttons end with the app taking the agent's result;
 * undo ends with the user taking it. That is deliberate and it is not
 * tidiness waiting to happen, so it is asserted as a difference rather than
 * only as two separate behaviours that happen to differ.
 */
describe("who takes the result", () => {
  const conflictingRemote = async () => {
    const { cwd, service } = await build();
    const base = head(cwd);
    git(cwd, ["checkout", "-q", "-b", "other", base]);
    const tip = await commit(cwd, "app.ts", "export const app = 'phone';\n", "Elsewhere");
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["update-ref", "refs/remotes/stella-fork/main", tip]);
    git(cwd, ["branch", "-D", "other"]);
    await commit(cwd, "app.ts", "export const app = 'desk';\n", "Here");
    trackFork(service, "main");
    return { cwd, service };
  };

  const conflictingUndo = async () => {
    const { cwd, service } = await build();
    const change = await commit(cwd, "app.ts", "export const app = 2;\n", "Change it");
    await commit(cwd, "app.ts", "export const app = 3;\n", "Build on it");
    return { cwd, service, change };
  };

  it("takes a merge it asked for, and leaves an undo to the user", async () => {
    const merge = await conflictingRemote();
    await merge.service.applyRemote();
    const undo = await conflictingUndo();
    await undo.service.undo(undo.change);

    // Reconciling a change the user asked for with the current version is not
    // a decision about what they wanted, so the app finishes the job.
    expect((await published(merge.service)).update).toEqual({ state: "merging" });

    // Removing a change that later work was built on is a different kind of
    // question. Pressing Undo is consent to remove the change; it is not
    // consent to whatever an agent decides the work built on top of it should
    // become, and that has no single right answer. So the agent's draft goes
    // to the chat like any other change and the user applies it having seen
    // it. If this ever starts matching the merge above, that decision was
    // flattened for symmetry rather than changed on purpose.
    expect((await published(undo.service)).update).toBeUndefined();
  });
});

describe("undoing a change later work was built on", () => {
  it("sends a brief and claims nothing about doing it", async () => {
    const { cwd, service } = await build();
    const change = await commit(cwd, "app.ts", "export const app = 2;\n", "Change it");
    await commit(cwd, "app.ts", "export const app = 3;\n", "Build on it");
    const before = head(cwd);

    const result = await service.undo(change);

    expect(result).toEqual({ ok: true, background: true });
    expect(head(cwd)).toBe(before);
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.prompt).toContain(change);
    expect(dispatched[0]!.prompt).toContain("app.ts");
    expect(dispatched[0]!.prompt).toContain("they apply themselves");
    // Deliberately no background line: the agent's own draft is what the
    // user looks at, and the app does not take this one by itself.
    expect((await published(service)).update).toBeUndefined();
  });

  it("still undoes a change nothing was built on, in place", async () => {
    const { cwd, service } = await build();
    const change = await commit(cwd, "app.ts", "export const app = 2;\n", "Change it");
    await commit(cwd, "other.ts", "export const o = 1;\n", "Unrelated");

    const result = await service.undo(change);

    expect(result).toEqual({ ok: true });
    expect(dispatched).toEqual([]);
    expect(
      await fs.readFile(path.join(cwd, "app.ts"), "utf8"),
    ).toBe("export const app = 1;\n");
  });
});
