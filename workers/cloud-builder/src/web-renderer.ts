/**
 * Owners' browser renderers. A desktop that pushes a change to the app's UI
 * builds the browser renderer from its fork and uploads it here; the website
 * serves it on its own origin through a rewrite to the public route.
 *
 *   PUT /api/app-source/web-renderer/<treeSha>          (signed-in owner, uncompressed tar)
 *   GET /web-renderer/<forkName>/<treeSha>/<path>        (public, immutable)
 *
 * Files live in `APP_BUILDS` under `web-renderers/<forkName>/<treeSha>/`.
 * Both path parts are unguessable hashes, so the URL itself is the
 * capability; the owner object records which tree is current.
 */

import { WEB_RENDERER_UPLOAD_PREFIX } from "@stella/contracts/backend/app-source";
import { rpcErrorStatus, type RpcResponse } from "@stella/contracts/backend/protocol";
import { TREE_SHA_PATTERN, webRendererPrefix } from "./owner-store/domains/app-source.js";
import { verifyCaller } from "./owner-store/routes.js";

export const WEB_RENDERER_PUBLIC_PREFIX = "/web-renderer/";

const MAX_TAR_BYTES = 64 * 1024 * 1024;
/** R2 operations count as subrequests; stay well under the per-request limit. */
const MAX_FILES = 800;
const PUT_CONCURRENCY = 16;
const FORK_NAME_PATTERN = /^u-[0-9a-f]{24}$/;

type WebRendererEnv = Pick<Cloudflare.Env, "OWNER_GATES" | "CLOUD_BUILDER_PUBLIC_URL" | "APP_BUILDS">;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain; charset=utf-8",
};

const contentTypeOf = (path: string) =>
  CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** A safe relative path, or null. */
const cleanPath = (raw: string): string | null => {
  const path = raw.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\\")) return null;
  const parts = path.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? null : path;
};

const decoder = new TextDecoder();
const field = (block: Uint8Array, start: number, length: number) => {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};

/** Regular files from a ustar archive (PAX `path` records honoured). Throws on anything else. */
export const readTar = (archive: Uint8Array): Array<{ path: string; bytes: Uint8Array }> => {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Bad tar entry size.");
    const type = String.fromCharCode(header[156] ?? 0);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    if (body.byteLength !== size) throw new Error("Truncated tar archive.");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(body))?.[1] ?? null;
      continue;
    }
    if (type === "g" || type === "5") continue;
    if (type !== "0" && type !== "\0") throw new Error("The archive may only hold files.");
    const prefix = field(header, 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    paxPath = null;
    const path = cleanPath(name);
    if (!path) throw new Error(`Bad path in archive: ${name}`);
    files.push({ path, bytes: body });
  }
  return files;
};

const ownerInternal = async (
  env: WebRendererEnv,
  ownerId: string,
  ownerGeneration: string,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const response = (await env.OWNER_GATES.getByName(ownerId).ownerInternal({
    name,
    args,
    ownerGeneration,
  })) as RpcResponse;
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response.value;
};

const upload = async (
  request: Request,
  env: WebRendererEnv,
  treeSha: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> => {
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(env, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!verified.ok) return fail(rpcErrorStatus(verified.error.code), verified.error.message);
  const { caller } = verified;
  if (caller.isAnonymous) return fail(403, "Sign in with an account to use this.");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_TAR_BYTES) {
    return fail(413, "The renderer is too large.");
  }
  const archive = new Uint8Array(await request.arrayBuffer());
  if (archive.byteLength > MAX_TAR_BYTES) return fail(413, "The renderer is too large.");
  let files: Array<{ path: string; bytes: Uint8Array }>;
  try {
    files = readTar(archive);
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : String(error));
  }
  if (!files.some((file) => file.path === "index.html")) return fail(400, "The renderer has no index.html.");
  if (files.length > MAX_FILES) return fail(413, "The renderer has too many files.");

  try {
    const ownerGeneration = (await env.OWNER_GATES.getByName(caller.ownerId).snapshot()).ownerGeneration;
    const { forkName } = (await ownerInternal(env, caller.ownerId, ownerGeneration, "appSource.webRendererFork", {})) as {
      forkName: string | null;
    };
    if (!forkName) return fail(409, "You have no copy of Stella's source yet.");
    const prefix = `${webRendererPrefix(forkName)}${treeSha}/`;
    for (let index = 0; index < files.length; index += PUT_CONCURRENCY) {
      await Promise.all(
        files.slice(index, index + PUT_CONCURRENCY).map((file) =>
          env.APP_BUILDS.put(`${prefix}${file.path}`, file.bytes, {
            httpMetadata: { contentType: contentTypeOf(file.path) },
          }),
        ),
      );
    }
    const { retired } = (await ownerInternal(env, caller.ownerId, ownerGeneration, "appSource.recordWebRenderer", {
      treeSha,
    })) as { retired: string | null };
    if (retired) waitUntil(sweep(env.APP_BUILDS, `${webRendererPrefix(forkName)}${retired}/`));
    return Response.json({ path: `u/${forkName}/${treeSha}/`, files: files.length });
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error(JSON.stringify({
      event: "web_renderer_upload_failed",
      code,
      message: error instanceof Error ? error.message : String(error),
    }));
    return fail(code === "CONFLICT" ? 409 : 503, "The renderer couldn't be stored. Try again.");
  }
};

const sweep = async (bucket: R2Bucket, prefix: string) => {
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (listing.objects.length > 0) await bucket.delete(listing.objects.map((entry) => entry.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
};

const serve = async (request: Request, env: WebRendererEnv, rest: string): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "Method not allowed.");
  const [forkName = "", treeSha = "", ...parts] = rest.split("/");
  const file = parts.length === 0 || parts.at(-1) === "" ? [...parts.filter(Boolean), "index.html"].join("/") : parts.join("/");
  let path: string | null;
  try {
    path = cleanPath(decodeURIComponent(file));
  } catch {
    path = null;
  }
  if (!FORK_NAME_PATTERN.test(forkName) || !TREE_SHA_PATTERN.test(treeSha) || !path) {
    return fail(404, "Not found.");
  }
  const object = await env.APP_BUILDS.get(`${webRendererPrefix(forkName)}${treeSha}/${path}`);
  if (!object) return fail(404, "Not found.");
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? contentTypeOf(path),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag,
    },
  });
};

/** The web-renderer routes, or null when the path is someone else's. */
export const handleWebRendererRoute = async (
  request: Request,
  env: WebRendererEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (path.startsWith(WEB_RENDERER_PUBLIC_PREFIX)) {
    return await serve(request, env, path.slice(WEB_RENDERER_PUBLIC_PREFIX.length));
  }
  if (!path.startsWith(WEB_RENDERER_UPLOAD_PREFIX)) return null;
  const treeSha = path.slice(WEB_RENDERER_UPLOAD_PREFIX.length);
  if (!TREE_SHA_PATTERN.test(treeSha)) return fail(404, "Not found.");
  if (request.method !== "PUT") return fail(405, "Method not allowed.");
  return await upload(request, env, treeSha, waitUntil);
};
