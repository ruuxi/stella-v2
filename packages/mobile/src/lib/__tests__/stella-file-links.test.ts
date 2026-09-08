import { describe, expect, test } from "bun:test";
import { stellaFileChatArtifact } from "../stella-file-links";

describe("stellaFileChatArtifact", () => {
  test("keeps a paired-computer path as a bridge-backed artifact", () => {
    const artifact = stellaFileChatArtifact("/Users/me/notes.md", "c1");
    expect(artifact.payload).toMatchObject({ kind: "markdown", filePath: "/Users/me/notes.md" });
    expect("driveBacked" in artifact.payload && artifact.payload.driveBacked).toBeFalsy();
  });

  test("opens a link into the cloud world's drive as a drive-backed artifact", () => {
    const artifact = stellaFileChatArtifact("/workspace/world/drive/reports/notes.md", "c1");
    expect(artifact.payload).toMatchObject({
      kind: "markdown",
      filePath: "reports/notes.md",
      title: "notes.md",
      driveBacked: true,
    });
    expect(artifact.conversationId).toBe("c1");
  });
});
