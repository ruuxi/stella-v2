import { WorldStore } from "../../src/world-store.js";
import { sha256BytesHex } from "../../src/hash.js";
import { WORLD_CHANGE_LOG_MAX_ROWS } from "../../src/world/types.js";

export { WorldStore };

type Env = { WORLDS: DurableObjectNamespace<WorldStore> };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    const world = env.WORLDS.getByName("fixture-world");
    if (new URL(request.url).pathname === "/entries") {
      return Response.json(await world.list("", {}));
    }
    if (new URL(request.url).pathname === "/compaction") {
      const compacted = env.WORLDS.getByName("fixture-compaction");
      const entries = Array.from(
        { length: WORLD_CHANGE_LOG_MAX_ROWS + 1 },
        (_, index) => ({
          path: `bulk/${String(index).padStart(5, "0")}`,
          kind: "dir" as const,
          mode: 0o755,
          mtime: index,
          size: 0,
        }),
      );
      const pushed = await compacted.pushDiff({ entries, deleted: [] });
      return Response.json({
        pushed,
        changes: await compacted.changesSince(0),
      });
    }
    await world.writeFile("src/one.txt", encoder.encode("alpha\nbeta\n"), {});
    const before = decoder.decode(
      (await world.readFile("src/one.txt", {})) ?? new Uint8Array(),
    );
    const read = await world.tool({
      name: "Read",
      arguments: { file_path: "/workspace/world/src/one.txt" },
    });
    const anchor = /\s(2#[0-9a-z]{3})\t/u.exec(read.output)?.[1] ?? "";
    const edit = await world.tool({
      name: "Edit",
      arguments: {
        file_path: "/workspace/world/src/one.txt",
        anchor,
        new_string: "gamma",
      },
    });
    const grep = await world.tool({
      name: "Grep",
      arguments: {
        pattern: "gamma",
        path: "/workspace/world",
        output_mode: "content",
      },
    });
    const firstChanges = await world.changesSince(0);
    const secondChanges = await world.changesSince(firstChanges.revision);
    const cursor = `v1:${"a".repeat(64)}`;
    const first = await world.checkpoint({ historyCursor: cursor });
    const second = await world.checkpoint({ historyCursor: cursor });
    const newBytes = encoder.encode("pushed");
    const sha256 = await sha256BytesHex(newBytes);
    const listing = [
      {
        path: "pushed.txt",
        kind: "file" as const,
        mode: 0o644,
        mtime: 2,
        size: newBytes.byteLength,
        sha256,
      },
    ];
    const delta = await world.diff(listing);
    const missing = await world.pushDiff({
      entries: listing,
      deleted: delta.deleted,
    });
    const upload = await world.beginBlob();
    await world.appendBlob(upload.uploadId, newBytes);
    await world.finishBlob(upload.uploadId, { sha256 });
    const pushed = await world.pushDiff({
      entries: listing,
      deleted: delta.deleted,
    });
    const exported = await world.exportTar();
    const tar = new Uint8Array(await new Response(exported.body).arrayBuffer());
    return Response.json({
      before,
      edit,
      grep,
      firstChangeRevision: firstChanges.revision,
      secondChangeRevision: secondChanges.revision,
      idempotent: first.manifestId === second.manifestId,
      changed: delta.changed,
      deleted: delta.deleted,
      missing: missing.missingBlobs,
      pushed: pushed.missingBlobs,
      pushRevision: pushed.revision,
      after: decoder.decode(
        (await world.readFile("pushed.txt", {})) ?? new Uint8Array(),
      ),
      tarName: decoder.decode(tar.slice(0, 10)).replaceAll("\0", ""),
      tarContent: decoder.decode(tar.slice(512, 518)),
    });
  },
} satisfies ExportedHandler<Env>;
