import { WorldStore } from "../../src/world-store.js";
import { sha256BytesHex } from "../../src/hash.js";
import {
  WORLD_BLOB_BATCH_MAX_BYTES,
  WORLD_BLOB_FRAME_HEADER_BYTES,
  WORLD_CHANGE_LOG_MAX_ROWS,
} from "../../src/world/types.js";
import { handleWorldRoute } from "../../src/build-session/owner-purge-transfer.js";
import { issueWorldCapability } from "../../src/world-capability.js";

export { WorldStore };

type Env = Parameters<typeof handleWorldRoute>[1];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const routeWorld = `${"1".repeat(64)}:${"2".repeat(64)}`;

const blobFrame = (sha256: string, bytes: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(
    WORLD_BLOB_FRAME_HEADER_BYTES + bytes.byteLength,
  );
  for (let index = 0; index < 32; index += 1) {
    frame[index] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16);
  }
  new DataView(frame.buffer).setBigUint64(32, BigInt(bytes.byteLength), false);
  frame.set(bytes, WORLD_BLOB_FRAME_HEADER_BYTES);
  return frame;
};

const fragment = (
  bytes: Uint8Array,
  size: number,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/route-push") {
      const capability = await issueWorldCapability({
        secret: env.BUILDER_SERVICE_SECRET,
        worldName: routeWorld,
        turnId: "workerd-route-test",
        attemptGeneration: 1,
        now: Date.now(),
        ttlMs: 60_000,
      });
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${capability}`);
      return await handleWorldRoute(
        new Request(`https://builder.test/internal/worlds/${routeWorld}/push`, {
          method: "POST",
          headers,
          body: request.body,
        }),
        env,
        routeWorld,
        { kind: "push" },
      );
    }
    if (pathname === "/pax-export") {
      const paxWorld = env.WORLDS.getByName("fixture-pax-export");
      const longParent = Array.from({ length: 8 }, () =>
        "目录".repeat(20),
      ).join("/");
      const longPath = `${longParent}/文件-${"x".repeat(41)}😀.txt`;
      const longTarget = `${"目标/".repeat(30)}终点-🌟`;
      await paxWorld.writeFile(longPath, encoder.encode("roundtrip ✓"), {});
      await paxWorld.symlink(`${longParent}/链接`, longTarget, {});
      const exported = await paxWorld.exportTar();
      return new Response(exported.body, {
        headers: { "content-type": "application/x-tar" },
      });
    }
    if (pathname === "/put-blobs-cases") {
      const world = env.WORLDS.getByName("put-blobs-cases");
      const first = encoder.encode("first");
      const second = encoder.encode("second");
      const firstSha = await sha256BytesHex(first);
      const secondSha = await sha256BytesHex(second);
      const frames = new Uint8Array(
        blobFrame(firstSha, first).byteLength +
          blobFrame(secondSha, second).byteLength,
      );
      const firstFrame = blobFrame(firstSha, first);
      frames.set(firstFrame);
      frames.set(blobFrame(secondSha, second), firstFrame.byteLength);
      const split = await world.putBlobs(fragment(frames, 3));
      const expectedSha = await sha256BytesHex(encoder.encode("expected"));
      const mismatch = await world.putBlobs(
        fragment(blobFrame(expectedSha, encoder.encode("wrong")), 2),
      );
      const oversized = new Uint8Array(4 * 1024 * 1024 + 17).fill(0x61);
      const oversizedSha = await sha256BytesHex(oversized);
      const spilled = await world.putBlobs(
        fragment(blobFrame(oversizedSha, oversized), 127_003),
      );
      const tooLarge = new Uint8Array(WORLD_BLOB_FRAME_HEADER_BYTES);
      new DataView(tooLarge.buffer).setBigUint64(
        32,
        BigInt(WORLD_BLOB_BATCH_MAX_BYTES + 1),
        false,
      );
      let refused = "";
      try {
        await world.putBlobs(fragment(tooLarge, 5));
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      return Response.json({
        split,
        mismatch,
        mismatchRecorded: Boolean(await world.exportBlob(expectedSha)),
        spilled,
        r2Bytes: (await env.WORLDS_BUCKET.get(`blobs/${oversizedSha}`))?.size,
        refused,
      });
    }
    const world = env.WORLDS.getByName("fixture-world");
    if (pathname === "/entries") {
      return Response.json(await world.list("", {}));
    }
    if (pathname === "/compaction") {
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
    if (pathname === "/fork") {
      const forkWorld = env.WORLDS.getByName("fixture-fork");
      await forkWorld.writeFile("base.txt", encoder.encode("shared"), {});
      const isolated = await forkWorld.fork({
        kind: "fork",
        threadId: "thread-fork",
      });
      const isolatedRoot = `/workspace/forks/${isolated.forkId}/world`;
      const write = await forkWorld.tool({
        name: "Write",
        fork: isolated.forkId,
        arguments: {
          file_path: `${isolatedRoot}/base.txt`,
          content: "isolated",
        },
      });
      const fresh = await forkWorld.fork({
        kind: "new",
        threadId: "thread-new",
      });
      return Response.json({
        isolated,
        write,
        shared: decoder.decode(
          (await forkWorld.readFile("base.txt", {})) ?? new Uint8Array(),
        ),
        forked: decoder.decode(
          (await forkWorld.readFile("base.txt", { fork: isolated.forkId })) ??
            new Uint8Array(),
        ),
        fresh: await forkWorld.list("", { fork: fresh.forkId }),
        status: await forkWorld.forkStatus(isolated.forkId),
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
    await world.putBlobs(fragment(blobFrame(sha256, newBytes), 2));
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
