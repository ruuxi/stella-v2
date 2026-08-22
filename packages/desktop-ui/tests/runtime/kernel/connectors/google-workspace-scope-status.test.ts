import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveConnectorTokenPayload } from "@stella/runtime/kernel/connectors/oauth";
import {
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import {
  getNativeConnectorConnectionState,
  getNativeConnectorReadiness,
  nativeConnectorAuthStatus,
} from "@stella/runtime/kernel/connectors/connection-status";
import {
  createConnectorStatusTool,
  resetConnectorStatusCatalogMemo,
  type ConnectorConnectionRequester,
} from "@stella/runtime/kernel/tools/defs/connector-status";
import {
  SCOPES,
  IDENTITY_SCOPES,
} from "@stella/runtime/kernel/google-workspace/scopes";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-gw-scope-"));
  roots.push(root);
  return root;
};

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const LEGACY_GRANT = [...IDENTITY_SCOPES, GMAIL_MODIFY];

const saveGrant = async (root: string, scopes: string[]) =>
  saveConnectorTokenPayload(root, "google-workspace", {
    accessToken: "gw-access",
    refreshToken: "gw-refresh",
    expiresAt: Date.now() + 60_000,
    clientId: "gw-client",
    scopes,
  });

const entry = (id: string) => getNativeConnectorCatalogEntry(id)!;

beforeEach(() => {
  installTestSafeStorage();
  resetConnectorStatusCatalogMemo();
});

afterEach(async () => {
  resetTestSafeStorage();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("google-workspace scope-aware connection status", () => {
  it("reports not_logged_in only when no grant exists", async () => {
    const root = makeRoot();
    expect(await nativeConnectorAuthStatus(root, entry("googlesheets"))).toBe(
      "not_logged_in",
    );
  });

  it("reports connected when the grant covers the service scope", async () => {
    const root = makeRoot();
    await saveGrant(root, SCOPES);
    expect(await nativeConnectorAuthStatus(root, entry("googlesheets"))).toBe(
      "connected",
    );
    expect(await nativeConnectorAuthStatus(root, entry("googletasks"))).toBe(
      "connected",
    );
    expect(await nativeConnectorAuthStatus(root, entry("gmail"))).toBe(
      "connected",
    );
  });

  it("reports scope_upgrade_required for a valid grant missing a service scope", async () => {
    const root = makeRoot();
    await saveGrant(root, LEGACY_GRANT);
    // The legacy grant still covers Gmail...
    expect(await nativeConnectorAuthStatus(root, entry("gmail"))).toBe(
      "connected",
    );
    // ...but not Sheets or Tasks, which need an incremental upgrade.
    expect(await nativeConnectorAuthStatus(root, entry("googlesheets"))).toBe(
      "scope_upgrade_required",
    );
    expect(await nativeConnectorAuthStatus(root, entry("googletasks"))).toBe(
      "scope_upgrade_required",
    );
  });

  it("treats the one-tap bundle as connected only with the full six-service union", async () => {
    const root = makeRoot();
    await saveGrant(root, LEGACY_GRANT);
    expect(await nativeConnectorAuthStatus(root, entry("googlesuper"))).toBe(
      "scope_upgrade_required",
    );
    await saveGrant(root, SCOPES);
    expect(await nativeConnectorAuthStatus(root, entry("googlesuper"))).toBe(
      "connected",
    );
  });

  it("keeps a scope-upgrade grant verified but not executable", async () => {
    const root = makeRoot();
    await saveGrant(root, LEGACY_GRANT);
    await enableNativeConnector(root, "googlesheets", "cli");
    const state = await getNativeConnectorConnectionState(
      root,
      entry("googlesheets"),
    );
    expect(state).toMatchObject({
      enabled: true,
      authStatus: "scope_upgrade_required",
      connected: false,
      // A valid grant is a verified account even when it lacks the scope.
      accountVerified: true,
    });
    const readiness = await getNativeConnectorReadiness(
      root,
      entry("googlesheets"),
    );
    expect(readiness.executable).toBe(false);
    expect(readiness.toolCount).toBeGreaterThan(0);
  });

  it("surfaces scope_upgrade_required through the connector_status tool and drives an incremental reconnect", async () => {
    const root = makeRoot();
    await saveGrant(root, LEGACY_GRANT);
    await enableNativeConnector(root, "googlesheets", "cli");
    const requester = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
    }));
    const tool = createConnectorStatusTool({
      stellaDataDir: root,
      requestConnectorConnection: requester as ConnectorConnectionRequester,
    });
    const result = await tool.execute({ connector: "googlesheets" }, context);
    expect(requester).toHaveBeenCalledTimes(1);
    expect(String(result.result)).toContain("access was upgraded");
    expect(result.details).toMatchObject({
      id: "googlesheets",
      status: "connected",
      reason: "scope_upgraded",
    });
  });

  it("explains the scope upgrade when no connect flow is available", async () => {
    const root = makeRoot();
    await saveGrant(root, LEGACY_GRANT);
    await enableNativeConnector(root, "googletasks", "cli");
    const tool = createConnectorStatusTool({ stellaDataDir: root });
    const result = await tool.execute({ connector: "googletasks" }, context);
    expect(String(result.result)).toContain("missing the permission");
    expect(result.details).toMatchObject({
      id: "googletasks",
      status: "scope_upgrade_required",
      reason: "missing_scope",
    });
  });
});
