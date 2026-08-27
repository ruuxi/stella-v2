import { shell } from "electron";
const COMPOSIO_OAUTH_HOSTS = new Set([
    "app.composio.dev",
    "connect.composio.dev",
    "backend.composio.dev",
]);
export const isApprovedComposioOAuthUrl = (value) => {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "https:" && COMPOSIO_OAUTH_HOSTS.has(parsed.hostname));
    }
    catch {
        return false;
    }
};
export class ConnectorOAuthService {
    async requestExternalOAuthApproval(payload) {
        if (!isApprovedComposioOAuthUrl(payload.resourceUrl)) {
            return { ok: false, reason: "untrusted_oauth_url" };
        }
        try {
            await shell.openExternal(payload.resourceUrl);
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                reason: error instanceof Error && error.message
                    ? error.message
                    : `Could not open ${payload.displayName} authorization.`,
            };
        }
    }
}
