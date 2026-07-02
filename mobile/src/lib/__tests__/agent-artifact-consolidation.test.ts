import { describe, expect, test } from "bun:test";
import type {
  ChatArtifact,
  MobileAgentWorkFileSection,
  MobileDisplayPayload,
} from "../../types";
import {
  agentWorkCardSections,
  consolidateRowArtifacts,
  isDeclaredOutputPath,
  isNoiseFileArtifact,
  isNoiseProducedPath,
  rankDeliverablesFirst,
} from "../agent-artifact-consolidation";
import { isMobileDisplayPayload } from "../mobile-artifacts";

const artifact = (
  id: string,
  payload: MobileDisplayPayload,
): ChatArtifact => ({ id, conversationId: "conv", payload });

const markdown = (id: string, filePath: string): ChatArtifact =>
  artifact(id, { kind: "markdown", filePath, createdAt: 1 });

const agentWork = (
  id: string,
  state: "running" | "done",
  agents?: MobileAgentWorkFileSection[],
): ChatArtifact =>
  artifact(id, {
    kind: "agent-work",
    state,
    total: 1,
    completed: state === "done" ? 1 : 0,
    title: "Research task",
    subtitle: state === "done" ? "Finished" : "Working in background",
    createdAt: 1,
    ...(agents !== undefined ? { agents } : {}),
  });

const mapRoute = (id: string): ChatArtifact =>
  artifact(id, {
    kind: "map-route",
    version: 1,
    markers: [{ id: "m1", name: "Place", lat: 1, lng: 2 }],
  });

describe("isNoiseProducedPath", () => {
  test("flags hidden dirs, caches, and scratch extensions", () => {
    expect(isNoiseProducedPath("/home/u/.brave-profile/Local State")).toBe(true);
    expect(isNoiseProducedPath("/repo/node_modules/pkg/readme.md")).toBe(true);
    expect(isNoiseProducedPath("/proj/__pycache__/mod.pyc")).toBe(true);
    expect(isNoiseProducedPath("/tmp/run/build.log")).toBe(true);
    expect(isNoiseProducedPath("/tmp/run/deps.lock")).toBe(true);
    expect(isNoiseProducedPath("   ")).toBe(true);
  });

  test("keeps real deliverables — including under ~/.stella/outputs", () => {
    expect(isNoiseProducedPath("/Users/u/.stella/outputs/report.pdf")).toBe(false);
    expect(isNoiseProducedPath("/Users/u/Documents/notes.md")).toBe(false);
  });
});

describe("isDeclaredOutputPath", () => {
  test("matches the declared outputs home (prod and dev)", () => {
    expect(isDeclaredOutputPath("/Users/u/.stella/outputs/report.html")).toBe(true);
    expect(isDeclaredOutputPath("/dev/state/outputs/plan.md")).toBe(true);
    expect(isDeclaredOutputPath("/Users/u/Documents/report.html")).toBe(false);
  });
});

describe("isNoiseFileArtifact", () => {
  test("pathless payloads are never noise", () => {
    const text = artifact("t", {
      kind: "media",
      asset: { kind: "text", text: "hello" },
      createdAt: 1,
    });
    expect(isNoiseFileArtifact(text)).toBe(false);
  });

  test("reads the payload's primary file path", () => {
    expect(
      isNoiseFileArtifact(markdown("n", "/repo/node_modules/x/readme.md")),
    ).toBe(true);
    expect(isNoiseFileArtifact(markdown("k", "/docs/notes.md"))).toBe(false);
  });
});

describe("rankDeliverablesFirst", () => {
  test("declared outputs lead, stable within each group", () => {
    const a = markdown("a", "/repo/scratch/a.md");
    const b = markdown("b", "/Users/u/.stella/outputs/b.md");
    const c = markdown("c", "/repo/scratch/c.md");
    const d = markdown("d", "/Users/u/.stella/outputs/d.md");
    expect(rankDeliverablesFirst([a, b, c, d]).map((x) => x.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });
});

describe("consolidateRowArtifacts", () => {
  test("rows without agent work keep loose file cards", () => {
    const file = markdown("f", "/docs/notes.md");
    const map = mapRoute("map");
    const result = consolidateRowArtifacts([file, map]);
    expect(result.agentWork).toHaveLength(0);
    expect(result.maps.map((x) => x.id)).toEqual(["map"]);
    expect(result.looseFiles.map((x) => x.id)).toEqual(["f"]);
    expect(result.agentFiles).toHaveLength(0);
    expect(result.agentWorkSettled).toBe(false);
  });

  test("rows with agent work fold files into the card, none loose", () => {
    const work = agentWork("agent-work:a1", "done");
    const file = markdown("f", "/docs/notes.md");
    const result = consolidateRowArtifacts([file, work]);
    expect(result.agentWork.map((x) => x.id)).toEqual(["agent-work:a1"]);
    expect(result.agentFiles.map((x) => x.id)).toEqual(["f"]);
    expect(result.looseFiles).toHaveLength(0);
    expect(result.agentWorkSettled).toBe(true);
  });

  test("reveal gate stays closed while any covered agent is running", () => {
    const running = agentWork("agent-work:a1", "running");
    const done = agentWork("agent-work:a2", "done");
    const file = markdown("f", "/docs/notes.md");
    const result = consolidateRowArtifacts([file, running, done]);
    expect(result.agentWorkSettled).toBe(false);
    expect(result.agentFiles.map((x) => x.id)).toEqual(["f"]);
  });

  test("filters noise writes and ranks deliverables first", () => {
    const work = agentWork("agent-work:a1", "done");
    const scratch = markdown("scratch", "/repo/worktree/notes.md");
    const noise = markdown("noise", "/home/u/.brave-profile/state.md");
    const deliverable = markdown(
      "out",
      "/Users/u/.stella/outputs/report.md",
    );
    const result = consolidateRowArtifacts([scratch, noise, deliverable, work]);
    expect(result.agentFiles.map((x) => x.id)).toEqual(["out", "scratch"]);
  });

  test("noise filtering also applies to loose files", () => {
    const noise = markdown("noise", "/repo/node_modules/pkg/readme.md");
    const keep = markdown("keep", "/docs/notes.md");
    const result = consolidateRowArtifacts([noise, keep]);
    expect(result.looseFiles.map((x) => x.id)).toEqual(["keep"]);
  });

  test("bridge-consolidated rows keep remaining files loose (orchestrator-direct)", () => {
    // A card carrying `agents` (even empty) marks the new bridge contract:
    // agent files ride the card's sections, so the row's loose artifacts are
    // orchestrator-direct and must NOT be folded.
    const work = agentWork("agent-work:a1", "done", []);
    const direct = markdown("direct", "/docs/notes.md");
    const result = consolidateRowArtifacts([direct, work]);
    expect(result.agentFiles).toHaveLength(0);
    expect(result.looseFiles.map((x) => x.id)).toEqual(["direct"]);
  });
});

describe("agentWorkCardSections", () => {
  const workArtifact = (agents?: MobileAgentWorkFileSection[]) => {
    const raw = agentWork("agent-work:a1", "done", agents);
    const sections = consolidateRowArtifacts([raw]).agentWork[0];
    if (!sections) throw new Error("expected agent-work artifact");
    return sections;
  };

  test("returns null for pre-consolidation bridges (fallback path)", () => {
    expect(agentWorkCardSections(workArtifact(undefined))).toBe(null);
  });

  test("maps per-agent files to openable artifacts, skipping empty sections", () => {
    const sections = agentWorkCardSections(
      workArtifact([
        {
          agentId: "a1",
          title: "Write the report",
          files: [
            {
              kind: "pdf",
              filePath: "/Users/u/.stella/outputs/report.pdf",
            },
          ],
        },
        { agentId: "a2", title: "No files", files: [] },
      ]),
    );
    expect(sections).toHaveLength(1);
    expect(sections?.[0]).toMatchObject({
      key: "agent-work:a1:a1",
      title: "Write the report",
    });
    expect(sections?.[0]?.files[0]).toMatchObject({
      conversationId: "conv",
      payload: {
        kind: "pdf",
        filePath: "/Users/u/.stella/outputs/report.pdf",
      },
    });
    // Path-keyed id so the same file dedupes against the artifacts browser.
    expect(sections?.[0]?.files[0]?.id).toBe(
      "conv:pdf:/Users/u/.stella/outputs/report.pdf",
    );
  });
});

describe("agent-work payload validation with per-agent sections", () => {
  const base = {
    kind: "agent-work",
    state: "done",
    total: 1,
    completed: 1,
    title: "Task",
    subtitle: "Finished",
    createdAt: 1,
  };

  test("accepts payloads without agents (older desktops)", () => {
    expect(isMobileDisplayPayload(base)).toBe(true);
  });

  test("accepts well-formed per-agent sections", () => {
    expect(
      isMobileDisplayPayload({
        ...base,
        agents: [
          {
            agentId: "a1",
            title: "Write the report",
            files: [{ kind: "pdf", filePath: "/tmp/report.pdf" }],
          },
        ],
      }),
    ).toBe(true);
  });

  test("rejects malformed sections", () => {
    expect(
      isMobileDisplayPayload({
        ...base,
        agents: [{ agentId: "a1", title: "x", files: [{ kind: "pdf" }] }],
      }),
    ).toBe(false);
    expect(isMobileDisplayPayload({ ...base, agents: "nope" })).toBe(false);
  });
});
