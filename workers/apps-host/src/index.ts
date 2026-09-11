import { DurableObject } from "cloudflare:workers";

// Retain the deployed class identity without the retired proxy/capability pipeline.
// This avoids deleting persisted objects as a side effect of a code rollout.
export class AppFetchGate extends DurableObject {
  fetch() {
    return Promise.resolve(new Response("Gone", { status: 410 }));
  }
}

/** Separate origin for generated content. Account credentials never reach apps. */
export default {
  async fetch(request: Request, env: AppsHostBindings): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/healthz") return Response.json({ ok: true });
    if (!incoming.pathname.startsWith("/workspace-apps/"))
      return new Response("Not found", { status: 404 });
    const headers = new Headers();
    for (const name of ["content-type", "accept"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The binding pins the destination; neither the URL nor generated code can
    // select another upstream. The runtime validates the signed app session.
    try {
      return await env.CLOUD_APPS.fetch(
        new URL(
          incoming.pathname + incoming.search,
          "https://cloud-apps.internal",
        ),
        {
          method: request.method,
          headers,
          redirect: "manual",
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? { body: request.body }
            : {}),
        },
      );
    } catch {
      return new Response("App unavailable. Reopen the app to try again.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<AppsHostBindings>;
