import { BrowserProfileSession } from "./browser-profile-session.js";
import { GatewayError, publicErrorResponse, safeErrorCode } from "./errors.js";
import type { BrowserGatewayEnv } from "./profile-session-core.js";
import {
  PROFILE_ID,
  parseInteraction,
  parseOwnerPurge,
  parseProfileReset,
  parseTurnCommand,
  profileObjectName,
} from "./protocol.js";
import { readJsonBody } from "./request-body.js";

export { BrowserProfileSession };

const ROUTES = new Set([
  "/internal/turn/command",
  "/internal/interactions/status",
  "/internal/interactions/live-view",
  "/internal/interactions/session-transfer-capability",
  "/internal/interactions/session-transfer",
  "/internal/interactions/decision",
  "/internal/owners/profile/reset",
  "/internal/owners/purge",
]);

const profileOwnerFromBody = (
  path: string,
  body: unknown,
): { ownerId: string; parsed: unknown } => {
  if (path === "/internal/turn/command") {
    const parsed = parseTurnCommand(body);
    return { ownerId: parsed.authority.ownerId, parsed };
  }
  if (path.startsWith("/internal/interactions/")) {
    const parsed = parseInteraction(body, {
      requireDecision: path === "/internal/interactions/decision",
      requireSessionTransfer:
        path === "/internal/interactions/session-transfer",
    });
    return { ownerId: parsed.authority.ownerId, parsed };
  }
  if (path === "/internal/owners/profile/reset") {
    const parsed = parseProfileReset(body);
    return { ownerId: parsed.authority.ownerId, parsed };
  }
  const parsed = parseOwnerPurge(body);
  return { ownerId: parsed.ownerId, parsed };
};

export default {
  async fetch(request: Request, env: BrowserGatewayEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (!ROUTES.has(path)) {
        return publicErrorResponse(new GatewayError("not_found", 404));
      }
      const body = await readJsonBody(request);
      const { ownerId, parsed } = profileOwnerFromBody(path, body);
      const objectName = await profileObjectName(ownerId, PROFILE_ID);
      const stub = env.BROWSER_PROFILE_SESSIONS.getByName(objectName);
      const response = await stub.fetch(`https://browser-profile${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return publicErrorResponse(new Error("redirect denied"));
      }
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "browser-gateway",
          event: "request_failed",
          route: ROUTES.has(path) ? path : "unknown",
          code: safeErrorCode(error),
        }),
      );
      return publicErrorResponse(error);
    }
  },
} satisfies ExportedHandler<BrowserGatewayEnv>;
