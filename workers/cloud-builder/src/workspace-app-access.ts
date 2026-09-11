import { ownerAccess } from "./cloud-home-routes.js";
import { worldName } from "./workspace.js";
import { readBoundedRequestText } from "./bounded-body.js";
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(`stella.workspace-app.v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export async function mintWorkspaceAppAccess(
  env: Env,
  ownerId: string,
  slug: string,
) {
  const world = await worldName(ownerId);
  const generation = await ownerAccess(env, ownerId);
  const expiresAt = Date.now() + 60 * 60_000;
  const payload = base64(
    encoder.encode(
      JSON.stringify({ world, slug, expiresAt, ownerId, generation }),
    ),
  );
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(env.BUILDER_SERVICE_SECRET),
        encoder.encode(payload),
      ),
    ),
  );
  return {
    url: `${env.APPS_HOST_BASE_URL.replace(/\/+$/, "")}/workspace-apps/${payload}.${signature}/`,
    expiresAt,
  };
}
export async function serveWorkspaceApp(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const match =
    /^\/workspace-apps\/([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})(\/.*)?$/.exec(
      url.pathname,
    );
  if (!match) return new Response("Not found", { status: 404 });
  let claims: {
    world: string;
    slug: string;
    expiresAt: number;
    ownerId: string;
    generation: string;
  };
  try {
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(env.BUILDER_SERVICE_SECRET),
        decode(match[2]!),
        encoder.encode(match[1]!),
      ))
    )
      throw new Error();
    claims = JSON.parse(new TextDecoder().decode(decode(match[1]!)));
    if (
      !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(claims.world) ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(claims.slug) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= Date.now() ||
      claims.expiresAt > Date.now() + 60 * 60_000
    )
      throw new Error();
  } catch {
    return new Response("App session expired. Reopen the app.", {
      status: 401,
    });
  }
  if (
    (await worldName(claims.ownerId)) !== claims.world ||
    (await ownerAccess(env, claims.ownerId)) !== claims.generation
  )
    return new Response("App unavailable", { status: 403 });
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-allow-methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  headers.set("access-control-allow-headers", "content-type");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; connect-src https:; base-uri 'none'; form-action 'none'",
  );
  if (request.method === "OPTIONS") return new Response(null, { headers });
  const target = new URL(match[3] || "/", "https://app.internal");
  target.search = url.search;
  const forwarded = new Headers();
  for (const name of ["content-type", "accept"]) {
    const v = request.headers.get(name);
    if (v) forwarded.set(name, v);
  }
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readBoundedRequestText(request, 1024 * 1024);
  const response = await env.WORLDS.getByName(claims.world).fetchWorkspaceApp(
    claims.slug,
    new Request(target, { method: request.method, headers: forwarded, body }),
  );
  // Generated code cannot set cookies, redirect to the parent, or relax its sandbox.
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(response.body, { status: response.status, headers });
}
