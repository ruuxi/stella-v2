import { interiorWrapperScript } from "../../src/interior-shell-wrapper";
import { createInteriorBridgeRuntimeSource } from "../../../../packages/executor-cloud/src/interior-bridge-runtime";

type Env = { PARENT_ORIGIN: string; GATEWAY_ORIGIN: string };

const stableRouteId = "sr_12345678-1234-4123-8123-123456789abc";

const testScript = `(() => {
  const finish = async () => {
    const bridge = window.__STELLA_INTERIOR_BRIDGE__;
    const result = {
      bridgePresent: Boolean(bridge),
      parentBootstrapReadable: false,
      storageAvailable: false,
      tokenOpaque: false,
      tokenInDom: false,
      sessionUser: null,
      directAuthReachable: false,
      windowName: window.name,
    };
    try { result.parentBootstrapReadable = parent.document.documentElement.dataset.bootstrap === "bootstrap-secret"; } catch {}
    try { localStorage.setItem("raw", "yes"); result.storageAvailable = true; } catch {}
    try {
      const session = await bridge.getSession();
      const token = await bridge.getToken();
      result.sessionUser = session.user.id;
      result.tokenOpaque = token.token.startsWith("v1.") && token.token.split(".").length !== 3;
      result.tokenInDom = document.documentElement.outerHTML.includes(token.token);
    } catch (error) { result.bridgeError = String(error); }
    try {
      const response = await fetch(bridge.gatewayOrigin + "/api/auth/convex/token", { credentials: "include" });
      result.directAuthReachable = response.ok;
    } catch {}
    document.body.dataset.result = JSON.stringify(result);
  };
  void finish();
})();`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const html = `<!doctype html><html data-bootstrap="bootstrap-secret" data-gateway-origin="${env.GATEWAY_ORIGIN}" data-stable-route-id="${stableRouteId}"><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe id="stella-interior" data-raw-src="/raw" sandbox="allow-scripts"></iframe><script src="/_stella/interior-wrapper.js"></script></html>`;
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src ${env.GATEWAY_ORIGIN}`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/_stella/interior-wrapper.js") {
      return new Response(interiorWrapperScript(), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/raw") {
      return new Response(
        '<!doctype html><meta charset="utf-8"><body><script src="/interior-bridge.js"></script><script src="/raw-test.js"></script>',
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'self'; script-src 'self'; connect-src ${env.GATEWAY_ORIGIN}; sandbox allow-scripts`,
          },
        },
      );
    }
    if (url.pathname === "/interior-bridge.js") {
      return new Response(
        createInteriorBridgeRuntimeSource({
          parentOrigin: env.PARENT_ORIGIN,
          gatewayOrigin: env.GATEWAY_ORIGIN,
        }),
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      );
    }
    if (url.pathname === "/raw-test.js") {
      return new Response(testScript, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
