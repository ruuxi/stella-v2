type Env = { PARENT_ORIGIN: string };

const cors = (env: Env) => ({
  "access-control-allow-origin": env.PARENT_ORIGIN,
  "access-control-allow-credentials": "true",
  vary: "Origin",
  "cache-control": "no-store",
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/interior/session") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(env),
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== env.PARENT_ORIGIN
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    const body = (await request.json()) as { bootstrap?: unknown };
    if (body.bootstrap !== "bootstrap-secret") {
      return new Response("Unauthorized", { status: 401 });
    }
    return Response.json(
      {
        token: "v1.opaque-interior-session-not-a-jwt",
        expiresAt: Date.now() + 120_000,
        user: {
          id: "viewer-workerd",
          email: null,
          name: "Workerd Viewer",
          image: null,
          isAnonymous: true,
        },
      },
      { headers: cors(env) },
    );
  },
};
