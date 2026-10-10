import { readJsonObject } from "../http/body.js";
import { requireCaller } from "../http/caller.js";
import { fail, failRpcError } from "../http/response.js";

const PREFIX = "/api/user-asks";
const MAX_BODY_BYTES = 192 * 1024;
const MAX_ASK_ID = 128;

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
  if (!resolved) return fail(404, "Not found");
  const verified = await requireCaller(request, env, { allowAnonymous: false });
  if (!verified.ok) {
    return failRpcError(verified.error, { code: verified.error.code });
  }
  const body =
    request.method === "GET"
      ? ({ ok: true, value: {} } as const)
      : await readJsonObject(request, MAX_BODY_BYTES, { allowEmpty: true });
  if (!body.ok) return fail(body.status, body.error);
  const deviceIdHeader = request.headers.get("x-stella-device-id")?.trim() ?? "";
  const result = await env.OWNER_GATES.getByName(
    verified.caller.ownerId,
  ).userAskRoute({
    route: resolved.route,
    askId: resolved.askId,
    caller: verified.caller,
    body: body.value,
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
