import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Keep native bridge doubles out of the shared mobile test module registry.
test("artifact reads recover a stale bridge once, retain binary fallback, and stop after cancellation", () => {
  const lib = resolve(__dirname, "..");
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const { BridgeRecoveryError, runWithSingleBridgeRecovery } = await import(${JSON.stringify(resolve(lib, "bridge-recovery.ts"))});
    const stale = { id: "stale" }, fresh = { id: "fresh" };
    const access = { desktopDeviceId: "paired-desktop" };
    let recoveries = 0, calls = [];
    let binary, invoke, recover = async () => fresh;
    mock.module(${JSON.stringify(resolve(lib, "desktop-bridge-chat.ts"))}, () => ({
      withDesktopBridgeRecovery: (requested, operation) => {
        assert.equal(requested, access);
        return runWithSingleBridgeRecovery({ initial: stale, operation,
          recover: () => { recoveries++; return recover(); } });
      },
      fetchDesktopBridgeFileBytes: async (bridge, conversation, path) => {
        calls.push(["binary", bridge.id]); return binary(bridge, conversation, path);
      },
      invokeDesktopBridge: async (bridge, channel, args) => {
        calls.push([channel, bridge.id]); return invoke(bridge, channel, args);
      },
    }));
    const api = await import(${JSON.stringify(resolve(lib, "desktop-artifact-data.ts"))});
    const expired = () => new BridgeRecoveryError("session", "Unauthorized");
    const reset = () => { calls = []; recoveries = 0; recover = async () => fresh; };
    const image = { missing: false, bytes: new Uint8Array([1, 2, 3]), sizeBytes: 3, mimeType: "image/png" };

    // Existing binary lane demotes HTTP401 to null; the legacy error triggers
    // one fresh handshake and the complete retry uses the fresh binary lane.
    binary = async bridge => bridge === stale ? null : image;
    invoke = async () => { throw expired(); };
    assert.deepEqual(await api.readDesktopArtifactFile(access, "chat", "image.png"), image);
    assert.deepEqual(calls, [["binary", "stale"], ["display:readFile", "stale"], ["binary", "fresh"]]);
    assert.equal(recoveries, 1);

    reset();
    binary = async () => null;
    invoke = async () => ({ bytes: [8, 9], sizeBytes: 2, mimeType: "text/plain" });
    assert.deepEqual((await api.readDesktopArtifactFile(access, "chat", "note.txt")).bytes, new Uint8Array([8, 9]));
    assert.equal(recoveries, 0, "unsupported binary lane retains legacy compatibility");

    reset();
    binary = async () => { throw expired(); };
    await assert.rejects(api.readDesktopArtifactFile(access, "chat", "image.png"), /Unauthorized/);
    assert.deepEqual(calls, [["binary", "stale"], ["binary", "fresh"]]);
    assert.equal(recoveries, 1, "a second stale session must not loop");

    reset();
    invoke = async (bridge, channel) => {
      if (channel === "officePreview:start") return { sessionId: "preview-" + bridge.id };
      if (bridge === stale) throw expired();
      return [{ sessionId: "preview-fresh", status: "ready", html: "<table>Recovered workbook</table>" }];
    };
    assert.equal(await api.loadOfficePreviewHtml(access, "chat", "sales.xlsx"), "<table>Recovered workbook</table>");
    assert.deepEqual(calls, [["officePreview:start", "stale"], ["officePreview:list", "stale"], ["officePreview:start", "fresh"], ["officePreview:list", "fresh"]]);

    reset();
    invoke = async bridge => {
      if (bridge === stale) throw expired();
      return [{ sessionId: "saved-preview", status: "ready", html: "<p>Document</p>" }];
    };
    assert.equal(await api.loadExistingOfficePreviewHtml(access, "chat", "saved-preview"), "<p>Document</p>");
    assert.equal(recoveries, 1);

    reset();
    const duringRead = new AbortController();
    binary = async () => { duringRead.abort(); throw expired(); };
    await assert.rejects(api.readDesktopArtifactFile(access, "chat", "image.png", duringRead.signal), { name: "AbortError" });
    assert.equal(recoveries, 0, "unmounted reads do not reconnect");
    assert.equal(calls.length, 1, "unmounted reads do not try legacy fallback");

    reset();
    const duringHandshake = new AbortController();
    binary = async () => { throw expired(); };
    recover = async () => { duringHandshake.abort(); return fresh; };
    await assert.rejects(api.readDesktopArtifactFile(access, "chat", "image.png", duringHandshake.signal), { name: "AbortError" });
    assert.equal(calls.length, 1, "a completed handshake cannot read after unmount");

    reset();
    const polling = new AbortController();
    invoke = async () => [];
    const pendingPreview = api.loadExistingOfficePreviewHtml(access, "chat", "pending", polling.signal);
    setTimeout(() => polling.abort(), 10);
    await assert.rejects(pendingPreview, { name: "AbortError" });
    assert.equal(calls.length, 1);
    assert.equal(recoveries, 0);
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
