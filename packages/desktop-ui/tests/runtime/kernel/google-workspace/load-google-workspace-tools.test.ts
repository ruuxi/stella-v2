import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGoogleWorkspaceTools } from "@stella/runtime/kernel/google-workspace/load-google-workspace-tools";
import { saveConnectorTokenPayload } from "@stella/runtime/kernel/connectors/oauth";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../../helpers/protected-storage.js";

beforeEach(() => installTestSafeStorage());
afterEach(() => resetTestSafeStorage());

describe("loadGoogleWorkspaceTools", () => {
  it("registers provider-safe allowlisted tools and time helpers work without Google auth", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-gw-"));
    try {
      const { tools, callTool, disconnect, hasStoredCredentials } =
        await loadGoogleWorkspaceTools({
          stellaAppDir: dir,
        });
      expect(tools.length).toBeGreaterThan(10);
      expect(callTool).toBeTypeOf("function");
      expect(hasStoredCredentials).toBe(false);
      expect(tools.every((tool) => !tool.name.includes("."))).toBe(true);
      expect(tools.some((tool) => tool.name === "time_getTimeZone")).toBe(true);

      const tz = await callTool!("time.getTimeZone", {});
      expect("result" in tz).toBe(true);
      expect(String((tz as { result?: unknown }).result)).toContain("timeZone");

      await disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("disconnect tears down runtime state without deleting stored credentials", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stella-gw-"));
    const credentialsPath = path.join(dir, "connectors", ".credentials.json");
    try {
      await loadGoogleWorkspaceTools({
        stellaAppDir: dir,
      }).then(async ({ disconnect }) => {
        await saveConnectorTokenPayload(dir, "google-workspace", {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
          clientId: "client-id",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
        });
        expect(existsSync(credentialsPath)).toBe(true);
        await disconnect();
        expect(existsSync(credentialsPath)).toBe(true);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
