import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMicrosoftGraphTools } from "@stella/runtime/kernel/microsoft-graph/load-microsoft-graph-tools";
import { MicrosoftAuthManager } from "@stella/runtime/kernel/microsoft-graph/MicrosoftAuthManager";
import { MICROSOFT_GRAPH_SCOPES } from "@stella/runtime/kernel/microsoft-graph/scopes";
import {
  loadConnectorAccessToken,
  saveConnectorTokenPayload,
} from "@stella/runtime/kernel/connectors/oauth";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

const TOKEN_KEY = "native-oauth:microsoft";

beforeEach(() => installTestSafeStorage());
afterEach(() => resetTestSafeStorage());

const saveGrant = (dir: string, scopes: string[]) =>
  saveConnectorTokenPayload(dir, TOKEN_KEY, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60_000,
    clientId: "client-id",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes,
  });

describe("loadMicrosoftGraphTools", () => {
  it("registers underscore-named allowlisted tools across the three services", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      const { tools, callTool, hasStoredCredentials } =
        await loadMicrosoftGraphTools({ stellaAppDir: dir });
      expect(tools.length).toBe(15);
      expect(callTool).toBeTypeOf("function");
      expect(hasStoredCredentials).toBe(false);
      // Registration names must not contain dots.
      expect(tools.every((tool) => !tool.name.includes("."))).toBe(true);
      expect(tools.some((t) => t.name === "outlook_sendMail")).toBe(true);
      expect(tools.some((t) => t.name === "teams_sendChannelMessage")).toBe(true);
      expect(tools.some((t) => t.name === "excel_updateRange")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses tool calls with a connect-actionable error when not connected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      const { callTool } = await loadMicrosoftGraphTools({ stellaAppDir: dir });
      const result = await callTool("outlook.listMessages", {});
      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toMatch(/not connected/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("disconnect forgets the shared Microsoft grant", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      await saveGrant(dir, MICROSOFT_GRAPH_SCOPES);
      const { disconnect, hasStoredCredentials } =
        await loadMicrosoftGraphTools({ stellaAppDir: dir });
      expect(hasStoredCredentials).toBe(true);
      await disconnect();
      expect(await loadConnectorAccessToken(dir, TOKEN_KEY)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MicrosoftAuthManager scope-aware gating", () => {
  it("returns the token when the grant covers the required scopes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      await saveGrant(dir, MICROSOFT_GRAPH_SCOPES);
      const auth = new MicrosoftAuthManager(dir, ["Mail.Send"]);
      await expect(auth.getAccessToken()).resolves.toBe("access-token");
      expect(await auth.hasStoredCredentials()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("demands reconnect when a required scope is missing from the grant", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      await saveGrant(dir, ["openid", "User.Read", "Mail.ReadWrite"]);
      const auth = new MicrosoftAuthManager(dir, ["ChannelMessage.Send"]);
      await expect(auth.getAccessToken()).rejects.toThrow(/reconnect/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a connect error when no grant exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-ms-"));
    try {
      const auth = new MicrosoftAuthManager(dir, ["Mail.Send"]);
      await expect(auth.getAccessToken()).rejects.toThrow(/not connected/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
