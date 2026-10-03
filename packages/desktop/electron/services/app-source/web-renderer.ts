import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WEB_RENDERER_UPLOAD_PREFIX } from "@stella/contracts/backend/app-source";
import { git, gitRaw, run } from "./git.js";

/**
 * The owner's browser renderer follows their fork: after a push, when the
 * renderer's inputs changed since the last upload (or, before the first one,
 * differ from the published app), build it from the checkout with the
 * checkout's own build script and upload it as a tar keyed by the tree.
 * Owners who never changed the UI keep the shared website build.
 */

export type WebRendererDeps = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  log: (event: string, data: Record<string, unknown>) => void;
};

const RENDERER_INPUTS = ["packages/desktop-ui/", "packages/contracts/", "packages/theme/", "bun.lock"];
/** The commit whose renderer was last uploaded. */
const UPLOADED_REF = "refs/stella/web-renderer";
const UPSTREAM_REF = "refs/remotes/stella-upstream/main";
const BUILD_SCRIPT = "packages/desktop/scripts/build-web-renderer.ts";

const verifiedRef = async (cwd: string, ref: string) => {
  const result = await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : null;
};

/** An uncompressed ustar archive of every file under `root`. */
export const tarDirectory = (root: string): Buffer => {
  const blocks: Buffer[] = [];
  const names = (fs.readdirSync(root, { recursive: true }) as string[])
    .map((name) => name.replace(/\\/g, "/"))
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .sort();
  for (const name of names) {
    const body = fs.readFileSync(path.join(root, name));
    const header = Buffer.alloc(512);
    const split = Buffer.byteLength(name) <= 100 ? -1 : name.lastIndexOf("/");
    const [prefix, base] = split < 0 ? ["", name] : [name.slice(0, split), name.slice(split + 1)];
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`Path too long for the renderer archive: ${name}`);
    }
    const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
    header.write(base, 0);
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(body.byteLength, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(prefix, 345);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};

const uploadOnce = async (cwd: string, deps: WebRendererDeps) => {
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const base = (await verifiedRef(cwd, UPLOADED_REF)) ?? (await verifiedRef(cwd, UPSTREAM_REF));
  if (base) {
    const changed = await git(cwd, ["diff", "--name-only", base, head, "--", ...RENDERER_INPUTS]);
    if (!changed) return;
  }
  const baseUrl = deps.getBackendUrl()?.replace(/\/+$/, "");
  const token = await deps.getAuthToken();
  if (!baseUrl || !token) return;
  const treeSha = await git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-web-renderer-"));
  const startedAt = Date.now();
  try {
    const bun = process.env.STELLA_BUN_PATH?.trim() || "bun";
    const build = await run(bun, [BUILD_SCRIPT, "--out", outDir], { cwd, timeoutMs: 10 * 60_000 });
    if (build.code !== 0) {
      throw new Error(`The browser renderer didn't build: ${(build.stderr || build.stdout).trim().slice(-400)}`);
    }
    const archive = tarDirectory(outDir);
    const response = await fetch(`${baseUrl}${WEB_RENDERER_UPLOAD_PREFIX}${treeSha}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-tar" },
      body: new Uint8Array(archive),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) {
      throw new Error(`The browser renderer upload failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    await git(cwd, ["update-ref", UPLOADED_REF, head]);
    deps.log("app-source.web-renderer-uploaded", {
      treeSha,
      bytes: archive.byteLength,
      ms: Date.now() - startedAt,
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
};

const inFlight = new Map<string, { running: Promise<void>; again: boolean }>();

/**
 * Build and upload the browser renderer for the checkout at `cwd` if its
 * inputs changed. Pushes that land while one runs coalesce into one more run.
 */
export const buildAndUploadWebRenderer = (cwd: string, deps: WebRendererDeps): Promise<void> => {
  const current = inFlight.get(cwd);
  if (current) {
    current.again = true;
    return current.running;
  }
  const entry = { running: Promise.resolve(), again: false };
  entry.running = (async () => {
    try {
      do {
        entry.again = false;
        await uploadOnce(cwd, deps);
      } while (entry.again);
    } finally {
      inFlight.delete(cwd);
    }
  })();
  inFlight.set(cwd, entry);
  return entry.running;
};
