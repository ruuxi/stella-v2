import { describe, expect, test } from "bun:test";
import { TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH } from "@stella/contracts/turn-credential-broker";
import {
  CLOUD_GENERAL_PROMPT,
  PUBLISH_STELLA_INTERIOR_TOOL,
  cloudPinnedWorkspaceTools,
  requestStellaInteriorBuild,
} from "./agent-turn.js";
import type { WorkspaceIdentity } from "./workspace-paths.js";

const stellaWorkspace: WorkspaceIdentity = {
  kind: "stella",
  workspace: "stella",
  slug: "",
  root: "/workspace/stella",
};

describe("stella interior publish tool", () => {
  test("is pinned only for a Stella-interior workspace", () => {
    expect(
      cloudPinnedWorkspaceTools("stella").map((tool) => tool.name),
    ).toEqual([PUBLISH_STELLA_INTERIOR_TOOL]);
    for (const kind of ["drive", "project", "app"] as const) {
      expect(cloudPinnedWorkspaceTools(kind)).toEqual([]);
    }
  });

  test("posts the broker command and acknowledges the deferred build", async () => {
    const posted: Array<{ route: string; body: unknown }> = [];
    const result = await requestStellaInteriorBuild({
      post: async (route, body) => {
        posted.push({ route, body });
        return Response.json({ schemaVersion: 1, requested: true });
      },
      params: { note: "renderer refresh" },
    });

    expect(posted).toEqual([
      {
        route: TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
        body: { schemaVersion: 1, note: "renderer refresh" },
      },
    ]);
    expect(result.error).toBeUndefined();
    expect(String(result.result)).toContain(
      "Interior build will run when the turn completes successfully",
    );
    expect(String(result.result)).toContain("Settings");
  });

  test("reports a rejected request instead of claiming a build", async () => {
    const result = await requestStellaInteriorBuild({
      post: async () => new Response("no", { status: 403 }),
      params: {},
    });
    expect(result.result).toBeUndefined();
    expect(result.error).toContain("could not accept");
  });

  test("refuses an out-of-bounds note before any broker sequence is spent", async () => {
    let posts = 0;
    const result = await requestStellaInteriorBuild({
      post: async () => {
        posts += 1;
        return Response.json({});
      },
      params: { note: "x".repeat(513) },
    });
    expect(posts).toBe(0);
    expect(result.error).toContain("512");
  });

  test("tells the agent the build is opt-in and the user still selects it", () => {
    const prompt = CLOUD_GENERAL_PROMPT({
      workspace: stellaWorkspace,
      office: false,
    });
    expect(prompt).toContain(PUBLISH_STELLA_INTERIOR_TOOL);
    expect(prompt).toContain("Nothing is built or published unless you ask");
    expect(prompt).toContain("selects that candidate in Settings");
    expect(prompt).not.toContain("Stella automatically runs");
  });
});
