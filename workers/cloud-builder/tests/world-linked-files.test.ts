import { describe, expect, test } from "bun:test";
import {
  contentTypeForName,
  deliverWorldLinkedFiles,
  worldLinkedDriveTargets,
} from "../src/build-session/world-linked-files.js";

describe("worldLinkedDriveTargets", () => {
  test("keeps only drive files the reply links, once each, by world and drive path", () => {
    const text = [
      "Done — see [report](/workspace/world/drive/reports/a.md) and",
      "[the same](</workspace/world/drive/reports/a.md>), plus",
      "[scratch](/workspace/world/notes.txt), [state](/workspace/world/drive/.stella/x),",
      "[outside](/etc/passwd), and `[code](/workspace/world/drive/ignored.md)`.",
    ].join(" ");
    expect(worldLinkedDriveTargets(text, "/workspace/world")).toEqual([
      { worldPath: "drive/reports/a.md", drivePath: "reports/a.md", name: "a.md" },
    ]);
  });

  test("names content types by extension", () => {
    expect(contentTypeForName("a.md")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeForName("deck.pptx")).toContain("presentationml");
    expect(contentTypeForName("blob")).toBe("application/octet-stream");
  });
});

describe("deliverWorldLinkedFiles", () => {
  const turn = {
    turnId: "turn-1",
    ownerId: "owner",
    threadId: "thread-1",
  } as unknown as Parameters<typeof deliverWorldLinkedFiles>[1]["turn"];

  const makeHost = (events: Array<{ kind: string; payload: unknown }>) =>
    ({
      emitTurnEvent: async (_turn: unknown, kind: string, payload: unknown) => {
        events.push({ kind, payload });
        return events.length;
      },
    }) as unknown as Parameters<typeof deliverWorldLinkedFiles>[0];

  test("announces the linked files the drive holds, without uploading them again", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const looked: string[] = [];
    const delivered = await deliverWorldLinkedFiles(makeHost(events), {
      turn,
      finalText:
        "Wrote [hello.txt](/workspace/world/drive/hello.txt), [gone](/workspace/world/drive/gone.md) and [dir](/workspace/world/drive/dir).",
      signal: new AbortController().signal,
      drive: {
        stat: async (path) => {
          looked.push(path);
          return path === "drive/hello.txt"
            ? { kind: "file", size: 3 }
            : path === "drive/dir"
              ? { kind: "dir", size: 0 }
              : null;
        },
      },
    });
    expect(looked).toEqual(["drive/hello.txt", "drive/gone.md", "drive/dir"]);
    expect(delivered).toEqual(["hello.txt"]);
    expect(events).toEqual([{
      kind: "output_files",
      payload: { files: [{ path: "hello.txt", name: "hello.txt", sizeBytes: 3, contentType: "text/plain; charset=utf-8", stored: true }] },
    }]);
  });

  test("announces nothing when the reply links nothing the drive holds", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    expect(await deliverWorldLinkedFiles(makeHost(events), {
      turn, finalText: "All done, nothing written.", signal: new AbortController().signal,
      drive: { stat: async () => ({ kind: "file", size: 3 }) },
    })).toEqual([]);
    expect(await deliverWorldLinkedFiles(makeHost(events), {
      turn, finalText: "[a](/workspace/world/drive/a.md)", signal: new AbortController().signal,
      drive: { stat: async () => null },
    })).toEqual([]);
    expect(events).toEqual([]);
  });
});
