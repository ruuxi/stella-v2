import { WorldStore } from "../../src/world-store";
export { WorldStore };
export default {
  async fetch(
    request: Request,
    env: { WORLDS: DurableObjectNamespace<WorldStore> },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const world = env.WORLDS.getByName(
      url.searchParams.get("owner") ?? "alice",
    );
    if (url.pathname === "/write") {
      const { path, text } = (await request.json()) as {
        path: string;
        text: string;
      };
      return Response.json(
        await world.tool({
          name: "Write",
          arguments: { file_path: "/workspace/world/" + path, content: text },
        }),
      );
    }
    if (url.pathname === "/apps")
      return Response.json(await world.listWorkspaceApps());
    // Consume the incoming body before the Durable Object call, as
    // workspace-app-access.ts does. Wrangler dev delivers it as an RPC stream,
    // and leaving it unread races the response into "Network connection lost".
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text();
    return world.fetchWorkspaceApp(
      "counter",
      new Request("https://app.internal" + url.pathname, {
        method: request.method,
        body,
      }),
    );
  },
};
