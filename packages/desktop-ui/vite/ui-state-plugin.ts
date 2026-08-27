import type { Plugin, ViteDevServer } from "vite";
import { UiStateStore } from "@stella/runtime/kernel/ui-state/store";
import { resolveRuntimeStatePath } from "@stella/runtime/kernel/home/stella-paths";
import {
  UI_STATE_DEV_ENDPOINT,
  UI_STATE_DEV_EVENT,
  sanitizeUiStateChanges,
  type UiStateChanges,
  type UiStateDevChangedEvent,
} from "@stella/contracts/ui-state";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const escapeInlineJson = (value: string): string =>
  value
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const readJsonBody = async (
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export function uiStateSharedStore(): Plugin {
  let store: UiStateStore | null = null;
  const getStore = () => {
    store ??= new UiStateStore(resolveRuntimeStatePath());
    return store;
  };

  const isAuthorizedRequest = (
    req: import("node:http").IncomingMessage,
    server: ViteDevServer,
  ): boolean => {
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) return false;
    const origin = req.headers.origin;

    if (origin == null) return true;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
    const address = server.httpServer?.address();
    const boundPort =
      address && typeof address === "object"
        ? address.port
        : server.config.server.port;
    return Number(parsed.port) === boundPort;
  };

  return {
    name: "stella-ui-state",
    apply: "serve",

    transformIndexHtml() {
      const snapshot = escapeInlineJson(
        JSON.stringify(getStore().snapshot()),
      );
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `if (!window.__stellaUiState) { window.__stellaUiState = ${snapshot}; }`,
        },
      ];
    },

    configureServer(server) {
      const sharedStore = getStore();

      const broadcast = (event: UiStateDevChangedEvent) => {
        if (Object.keys(event.changes).length === 0) return;
        server.ws.send({
          type: "custom",
          event: UI_STATE_DEV_EVENT,
          data: event,
        });
      };

      const unsubscribe = sharedStore.onExternalChange(
        (changes: UiStateChanges) => broadcast({ clientId: null, changes }),
      );

      server.httpServer?.once("close", () => {
        unsubscribe();
        sharedStore.flushSync();
      });

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== UI_STATE_DEV_ENDPOINT) {
          return next();
        }

        const sendJson = (
          statusCode: number,
          payload: Record<string, unknown>,
        ) => {
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
        };

        if (!isAuthorizedRequest(req, server)) {
          sendJson(403, { ok: false, error: "Forbidden" });
          return;
        }
        if (req.method !== "POST") {
          sendJson(405, { ok: false, error: "Method not allowed" });
          return;
        }

        const body = await readJsonBody(req);
        const clientId =
          typeof body.clientId === "string" ? body.clientId : null;

        if (body.clear === true) {
          broadcast({ clientId, changes: sharedStore.clear() });
          sendJson(200, { ok: true });
          return;
        }

        const changes = sanitizeUiStateChanges(body.changes);
        if (!changes) {
          sendJson(400, { ok: false, error: "Invalid changes payload" });
          return;
        }
        broadcast({ clientId, changes: sharedStore.apply(changes) });
        sendJson(200, { ok: true });
      });
    },
  };
}
