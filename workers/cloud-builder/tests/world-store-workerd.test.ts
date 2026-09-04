import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";
import { createHash } from "node:crypto";

const FRAME_HEADER_BYTES = 40;
const frame = (sha256: string, bytes: Uint8Array): Uint8Array => {
  const output = new Uint8Array(FRAME_HEADER_BYTES + bytes.byteLength);
  for (let index = 0; index < 32; index += 1) {
    output[index] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16);
  }
  new DataView(output.buffer).setBigUint64(32, BigInt(bytes.byteLength), false);
  output.set(bytes, FRAME_HEADER_BYTES);
  return output;
};

const port = 20_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const packageRoot = new URL("..", import.meta.url);

describe("WorldStore in real Workerd", () => {
  let child: ChildProcess | null = null;
  let persistence = "";
  let output = "";

  beforeAll(async () => {
    persistence = await mkdtemp(join(tmpdir(), "stella-world-workerd-"));
    child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/world-store-workerd.wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistence,
        "--inspector-port",
        String(await allocateWorkerdInspectorPort()),
        "--show-interactive-dev-session=false",
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const observe = (chunk: unknown): void => {
      output += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`wrangler exited before readiness:\n${output}`);
      try {
        if ((await fetch(`${origin}/health`)).ok) return;
      } catch {}
      await Bun.sleep(50);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (persistence.includes("stella-world-workerd-"))
      await rm(persistence, { recursive: true, force: true });
  }, 30_000);

  test("runs tools, manifests, diff/push, and tar export", async () => {
    expect(await (await fetch(`${origin}/health`)).text()).toBe("ok");
    expect(await (await fetch(`${origin}/entries`)).json()).toEqual({
      entries: [],
    });
    const response = await fetch(origin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      before: "alpha\nbeta\n",
      edit: { ok: true },
      grep: { ok: true, output: expect.stringContaining("gamma") },
      firstChangeRevision: 1,
      secondChangeRevision: 2,
      idempotent: true,
      changed: ["pushed.txt"],
      missing: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
      pushed: [],
      pushRevision: 3,
      after: "pushed",
      tarName: "pushed.txt",
      tarContent: "pushed",
    });
  });

  test("roundtrips PAX paths and symlink targets at the world limits, including unicode", async () => {
    const response = await fetch(`${origin}/pax-export`);
    expect(response.status).toBe(200);
    const extraction = await mkdtemp(join(tmpdir(), "stella-world-pax-"));
    const archive = join(extraction, "world.tar");
    const destination = join(extraction, "restored");
    try {
      await mkdir(destination);
      await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
      const tar = spawn("/usr/bin/tar", ["-xf", archive, "-C", destination], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [exitCode] = (await once(tar, "exit")) as [number | null];
      expect(exitCode).toBe(0);

      const longParent = Array.from({ length: 8 }, () =>
        "目录".repeat(20),
      ).join("/");
      expect(
        await readFile(
          join(destination, longParent, `文件-${"x".repeat(41)}😀.txt`),
          "utf8",
        ),
      ).toBe("roundtrip ✓");
      expect(await readlink(join(destination, longParent, "链接"))).toBe(
        `${"目标/".repeat(30)}终点-🌟`,
      );
    } finally {
      await rm(extraction, { recursive: true, force: true });
    }
  });

  test("streams putBlobs frames, rejects bad sha, spills to R2, and enforces the byte cap", async () => {
    const response = await fetch(`${origin}/put-blobs-cases`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      split: [
        { accepted: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        { accepted: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      ],
      mismatch: [
        {
          accepted: false,
          error: expect.stringContaining("sha256 mismatch"),
        },
      ],
      mismatchRecorded: false,
      spilled: [{ accepted: true }],
      r2Bytes: 4 * 1024 * 1024 + 17,
      refused: expect.stringContaining("exceeds the 32 MiB request limit"),
    });
  }, 30_000);

  test("pushes three hundred small files through one framed route request", async () => {
    const encoder = new TextEncoder();
    const files = Array.from({ length: 300 }, (_, index) => {
      const bytes = encoder.encode(`small file ${index}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { index, bytes, sha256 };
    });
    const entries = files.map((file) => ({
      path: `small/${file.index}.txt`,
      kind: "file",
      mode: 0o644,
      mtime: file.index,
      size: file.bytes.byteLength,
      sha256: file.sha256,
    }));
    const listing = async () =>
      await fetch(`${origin}/route-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      });
    const missing = (await (await listing()).json()) as {
      missingBlobs: string[];
    };
    expect(missing.missingBlobs).toHaveLength(300);
    const frames = files.map((file) => frame(file.sha256, file.bytes));
    const wireBytes = frames.reduce((sum, value) => sum + value.byteLength, 0);
    const body = new Uint8Array(wireBytes);
    let offset = 0;
    for (const value of frames) {
      body.set(value, offset);
      offset += value.byteLength;
    }
    let uploadRequests = 0;
    uploadRequests += 1;
    const uploaded = await fetch(`${origin}/route-push`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.stella.world-blobs",
        "content-length": String(body.byteLength),
      },
      body,
    });
    expect(uploaded.status).toBe(200);
    expect(
      ((await uploaded.json()) as { outcomes: unknown[] }).outcomes,
    ).toHaveLength(300);
    expect(await (await listing()).json()).toMatchObject({
      missingBlobs: [],
    });
    expect(uploadRequests).toBe(1);
  }, 30_000);

  test("compacts an oversized change batch into resync", async () => {
    const response = await fetch(`${origin}/compaction`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pushed: { missingBlobs: [], revision: 1 },
      changes: {
        revision: 1,
        entries: [],
        deleted: [],
        resync: true,
      },
    });
  }, 30_000);

  test("keeps forked tools isolated and starts new workspaces empty", async () => {
    const response = await fetch(`${origin}/fork`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      write: { ok: true },
      shared: "shared",
      forked: "isolated",
      fresh: { entries: [] },
      status: {
        kind: "fork",
        changedSinceBase: 1,
        revision: 1,
      },
    });
    expect(body.isolated).toMatchObject({
      forkId: expect.stringMatching(/^fork-[0-9a-f-]{36}$/u),
      headManifestId: expect.stringMatching(/^live:/u),
    });
  });
});
