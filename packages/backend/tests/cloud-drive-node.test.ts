import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

test("Drive copy parses the real S3 XML response in the Node action without DOMParser", async () => {
  const actionPath = path.resolve(import.meta.dirname, "../convex/cloud_drive_node.ts");
  expect(await readFile(actionPath, "utf8")).toMatch(/^"use node";/);
  const requests: { method: string; path: string; source: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        source: request.headers.get("x-amz-copy-source"),
      });
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"test-etag"</ETag><LastModified>2026-09-05T00:00:00.000Z</LastModified></CopyObjectResult>',
        { headers: { "content-type": "application/xml" } },
      );
    },
  });
  const root = await mkdtemp(path.join(tmpdir(), "stella-drive-node-"));
  try {
    const entry = path.join(root, "entry.ts");
    const output = path.join(root, "entry.cjs");
    await writeFile(entry, `
      import { copyDriveObject } from ${JSON.stringify(actionPath)};
      if (typeof globalThis.DOMParser !== "undefined") throw new Error("DOMParser must be absent");
      copyDriveObject._handler({}, {
        stagingR2Key: "owner/staging/hello world.png",
        finalR2Key: "owner/final/image.png",
      }).then(value => {
        if (value !== null) throw new Error("Unexpected action result");
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `);
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const child = Bun.spawn(["node", output], {
      env: {
        ...process.env,
        R2_BUCKET: "test-bucket",
        R2_ENDPOINT: `http://127.0.0.1:${server.port}`,
        R2_ACCESS_KEY_ID: "test-key",
        R2_SECRET_ACCESS_KEY: "test-secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(requests).toEqual([{
      method: "PUT",
      path: "/test-bucket/owner/final/image.png",
      source: "test-bucket/owner/staging/hello%20world.png",
    }]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
