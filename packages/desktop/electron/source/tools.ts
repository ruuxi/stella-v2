/**
 * The packages the source server runs on, loaded on first use. A static
 * import would be hoisted to the top of the Electron main bundle and load on
 * every launch, including packaged ones, which don't ship them.
 */
export const loadSourceTools = async () => {
  const [rolldown, utils, experimental, tailwindNode, tailwindOxide, routerGenerator, cjsLexer] =
    await Promise.all([
      import("rolldown"),
      import("rolldown/utils"),
      import("rolldown/experimental"),
      import("@tailwindcss/node"),
      import("@tailwindcss/oxide"),
      import("@tanstack/router-generator"),
      import("cjs-module-lexer"),
    ]);
  const lexerInit = (cjsLexer as { init?: () => Promise<void> }).init;
  if (lexerInit) await lexerInit();
  return {
    rolldown: rolldown.rolldown,
    transform: utils.transform,
    parse: utils.parse,
    parseSync: utils.parseSync,
    ResolverFactory: experimental.ResolverFactory,
    compileTailwind: tailwindNode.compile,
    TailwindScanner: tailwindOxide.Scanner,
    RouteGenerator: routerGenerator.Generator,
    getRouteConfig: routerGenerator.getConfig,
    parseCommonJs: cjsLexer.parse,
  };
};

export type SourceTools = Awaited<ReturnType<typeof loadSourceTools>>;
