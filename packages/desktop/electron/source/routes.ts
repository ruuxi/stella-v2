import fs from "node:fs";
import path from "node:path";
import type { SourceTools } from "./tools.js";

/**
 * Keeps `src/routeTree.gen.ts` in step with `src/routes`, as the TanStack
 * router plugin did inside Vite. The generator only rewrites the file when
 * the tree changes.
 */
export const createRouteTreeGenerator = (tools: SourceTools, uiRoot: string) => {
  const inline = JSON.parse(
    fs.readFileSync(path.join(uiRoot, "tsr.config.json"), "utf8"),
  ) as Record<string, unknown>;
  const config = tools.getRouteConfig(inline, uiRoot);
  const generator = new tools.RouteGenerator({ config, root: uiRoot });
  const routesDirectory = path.resolve(uiRoot, config.routesDirectory);
  return {
    routesDirectory,
    run: async (event?: { path: string; type: "create" | "update" | "delete" }) => {
      await generator.run(event);
    },
  };
};
