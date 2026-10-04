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
  const bytes = new TextEncoder().encode("hi\n");

  const makeHost = (events: Array<{ kind: string; payload: unknown }>) =>
    ({
      env: { WORLDS: {} },
      emitTurnEvent: async (_turn: unknown, kind: string, payload: unknown) => {
        events.push({ kind, payload });
        return events.length;
      },
    }) as unknown as Parameters<typeof deliverWorldLinkedFiles>[0];

  test("registers the file with its bytes and announces it with an output_files event", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const posted: unknown[] = [];
    const delivered = await deliverWorldLinkedFiles(makeHost(events), {
      turn,
      finalText: "Wrote [hello.txt](/workspace/world/drive/hello.txt).",
      known: new Map([["hello.txt", 123]]),
      signal: new AbortController().signal,
      world: {
        stat: async (path) => (path === "drive/hello.txt" ? { kind: "file", size: bytes.byteLength } : null),
        readFile: async () => bytes,
      },
      drive: async (body) => {
        posted.push(body);
        return Response.json({ ok: true, renamed: [], skipped: [] });
      },
    });
    expect(delivered).toEqual(["hello.txt"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      turnId: "turn-1",
      batchKey: "turn-1:world:0",
      files: [{
        path: "hello.txt", name: "hello.txt", sizeBytes: 3, knownUpdatedAt: 123,
        contentType: "text/plain; charset=utf-8", contentBase64: btoa("hi\n"),
      }],
    });
    expect(events).toEqual([{
      kind: "output_files",
      payload: { files: [{ path: "hello.txt", name: "hello.txt", sizeBytes: 3, contentType: "text/plain; charset=utf-8", stored: true }] },
    }]);
  });

  test("honours a rename and a refusal from the drive, and skips links that are not files", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const delivered = await deliverWorldLinkedFiles(makeHost(events), {
      turn,
      finalText: "[a](/workspace/world/drive/a.md) [b](/workspace/world/drive/b.md) [dir](/workspace/world/drive/dir)",
      signal: new AbortController().signal,
      world: {
        stat: async (path) => (path === "drive/dir" ? { kind: "dir", size: 0 } : { kind: "file", size: 3 }),
        readFile: async () => bytes,
      },
      drive: async () =>
        Response.json({ ok: true, renamed: [{ from: "a.md", to: "a (agent copy).md", reason: "user upload kept" }], skipped: [{ path: "b.md", reason: "quota" }] }),
    });
    expect(delivered).toEqual(["a (agent copy).md"]);
    expect((events[0]!.payload as { files: Array<{ name: string }> }).files.map((f) => f.name)).toEqual(["a (agent copy).md"]);
  });

  test("announces nothing when the drive refuses the batch or the reply links nothing", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    expect(await deliverWorldLinkedFiles(makeHost(events), {
      turn, finalText: "All done, nothing written.", signal: new AbortController().signal,
      world: { stat: async () => null, readFile: async () => null },
    })).toEqual([]);
    expect(await deliverWorldLinkedFiles(makeHost(events), {
      turn, finalText: "[a](/workspace/world/drive/a.md)", signal: new AbortController().signal,
      world: { stat: async () => ({ kind: "file", size: 3 }), readFile: async () => bytes },
      drive: async () => Response.json({ skipped: [{ path: "a.md", reason: "too big" }] }, { status: 413 }),
    })).toEqual([]);
    expect(events).toEqual([]);
  });
});
