import { verifyCaller } from "../owner-store/routes.js";

const PREFIX = "/api/user-asks";
const MAX_BODY_BYTES = 192 * 1024;
const MAX_ASK_ID = 128;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readBody = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  if (request.method === "GET") return {};
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text) return {};
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

type Resolved = { route: string; askId: string };

const resolve = (method: string, path: string): Resolved | null => {
  const segments = path
    .slice(PREFIX.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    if (method === "GET") return { route: "GET asks", askId: "" };
    if (method === "POST") return { route: "POST ask", askId: "" };
    return null;
  }
  if (segments.length === 1 && segments[0] === "policy") {
    if (method === "GET") return { route: "GET policy", askId: "" };
    if (method === "PUT") return { route: "PUT policy", askId: "" };
    return null;
  }
  if (segments.length !== 2) return null;
  const askId = segments[0]!;
  const action = segments[1]!;
  if (!askId || askId.length > MAX_ASK_ID) return null;
  if (method === "GET") {
    return action === "answer" ? { route: "GET answer", askId } : null;
  }
  if (method !== "POST") return null;
  if (action !== "answer" && action !== "cancel" && action !== "escalate") {
    return null;
  }
  return { route: `POST ${action}`, askId };
};

const userAskRoute = async (
  request: Request,
  env: Cloudflare.Env,
  url: URL,
): Promise<Response> => {
  const resolved = resolve(request.method, url.pathname);
  if (!resolved) return json({ error: "Not found" }, 404);
  const header = request.headers.get("authorization") ?? "";
  const verified = await verifyCaller(
    env,
    header.startsWith("Bearer ") ? header.slice(7).trim() : "",
  );
  if (!verified.ok) {
    return json(
      { error: verified.error.message, code: verified.error.code },
      verified.error.code === "UNAUTHENTICATED" ? 401 : 503,
    );
  }
  if (verified.caller.isAnonymous) {
    return json({ error: "Sign in with an account to use this." }, 403);
  }
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object" }, 400);
  const deviceIdHeader = request.headers.get("x-stella-device-id")?.trim() ?? "";
  const result = await env.OWNER_GATES.getByName(
    verified.caller.ownerId,
  ).userAskRoute({
    route: resolved.route,
    askId: resolved.askId,
    caller: verified.caller,
    body,
    query: Object.fromEntries(url.searchParams),
    ...(deviceIdHeader ? { deviceIdHeader } : {}),
  });
  return new Response(result.json, {
    status: result.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
};

export const handleUserAsksRoute = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
    return null;
  }
  return await userAskRoute(request, env, url);
};
