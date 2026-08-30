import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import {
  createInteriorBridgePlugin,
  createInteriorBridgeRuntimeSource,
  STELLA_INTERIOR_BRIDGE_ASSET,
} from "./interior-bridge-runtime.js";

describe("immutable Stella interior bridge", () => {
  test("a real Vite production build places the bridge before modules in all four entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-interior-bridge-"));
    const output = path.join(root, "dist");
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(
        path.join(root, "src", "entry.js"),
        "globalThis.__INTERIOR_MODULE_RAN__ = true;\n",
      );
      const entries = ["index.html", "mini.html", "overlay.html", "pet.html"];
      await Promise.all(
        entries.map((entry) =>
          writeFile(
            path.join(root, entry),
            '<!doctype html><html><head></head><body><script type="module" src="./src/entry.js"></script></body></html>',
          ),
        ),
      );
      await build({
        root,
        base: "./",
        logLevel: "silent",
        plugins: [
          createInteriorBridgePlugin({
            parentOrigin: "https://apps.example.test",
            gatewayOrigin: "https://apps-auth.example.test",
          }),
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rolldownOptions: {
            input: Object.fromEntries(
              entries.map((entry) => [
                entry.replace(".html", ""),
                path.join(root, entry),
              ]),
            ),
          },
        },
      });

      for (const entry of entries) {
        const html = await readFile(path.join(output, entry), "utf8");
        const bridgeOffset = html.indexOf(STELLA_INTERIOR_BRIDGE_ASSET);
        const moduleOffset = html.indexOf('type="module"');
        expect(bridgeOffset).toBeGreaterThan(-1);
        expect(moduleOffset).toBeGreaterThan(bridgeOffset);
      }
      const runtime = await readFile(
        path.join(output, STELLA_INTERIOR_BRIDGE_ASSET),
        "utf8",
      );
      expect(runtime).toContain("stella-interior-child-v1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("injects one classic pre-module asset into every HTML entry", () => {
    const plugin = createInteriorBridgePlugin({
      parentOrigin: "https://apps.example.test",
      gatewayOrigin: "https://apps-auth.example.test",
    });
    const transform = plugin.transformIndexHtml;
    if (!transform || typeof transform === "function") {
      throw new Error("Expected an ordered HTML transform.");
    }
    expect(transform.order).toBe("pre");
    const tags = transform.handler.call(
      {} as never,
      "<html></html>",
      {} as never,
    ) as Array<{
      tag: string;
      attrs: Record<string, string>;
      injectTo: string;
    }>;
    expect(tags).toEqual([
      {
        tag: "script",
        attrs: { src: `./${STELLA_INTERIOR_BRIDGE_ASSET}` },
        injectTo: "head-prepend",
      },
    ]);
  });

  test("handshakes after opaque navigation clears window.name, then binds requests to the accepted nonce", async () => {
    const parentOrigin = "https://apps.example.test";
    const gatewayOrigin = "https://apps-auth.example.test";
    const nonce = "Q".repeat(32);
    const posted: Array<{ message: Record<string, unknown>; origin: string }> =
      [];
    const listeners: Array<(event: Record<string, unknown>) => void> = [];
    const parent = {
      postMessage(message: Record<string, unknown>, origin: string) {
        posted.push({ message, origin });
      },
    };
    const fakeWindow = {
      parent,
      // Real sandboxed opaque navigation clears the name set by its parent.
      name: "",
      setTimeout,
      clearTimeout,
      addEventListener(
        _name: string,
        listener: (event: Record<string, unknown>) => void,
      ) {
        listeners.push(listener);
      },
    } as Record<string, unknown>;
    const source = createInteriorBridgeRuntimeSource({
      parentOrigin,
      gatewayOrigin,
    });
    const execute = new Function("window", "crypto", source);
    execute(fakeWindow, crypto);

    const bridge = fakeWindow.__STELLA_INTERIOR_BRIDGE__ as {
      getToken(): Promise<{ token: string; expiresAt: number }>;
    };
    expect(bridge).toBeDefined();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(posted).toEqual([
      {
        message: { source: "stella-interior-child-ready-v1", v: 1 },
        origin: parentOrigin,
      },
    ]);
    const tokenPromise = bridge.getToken();
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    const init = {
      source: "stella-interior-parent-init-v1",
      v: 1,
      nonce,
      gatewayOrigin,
      stableRouteId: "sr_12345678-1234-4123-8123-123456789abc",
    };
    listeners[0]!({
      source: parent,
      origin: "https://attacker.example",
      data: init,
    });
    listeners[0]!({
      source: parent,
      origin: parentOrigin,
      data: { ...init, extra: true },
    });
    expect(posted).toHaveLength(1);

    listeners[0]!({ source: parent, origin: parentOrigin, data: init });
    // A second otherwise-valid init is ignored after the authority is fixed.
    listeners[0]!({
      source: parent,
      origin: parentOrigin,
      data: { ...init, nonce: "Z".repeat(32) },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.origin).toBe(parentOrigin);
    expect(posted[1]!.message).toMatchObject({
      source: "stella-interior-child-v1",
      v: 1,
      nonce,
      method: "token",
    });
    const id = posted[1]!.message.id as string;

    listeners[0]!({
      source: parent,
      origin: "https://attacker.example",
      data: {
        source: "stella-interior-parent-v1",
        v: 1,
        nonce,
        id,
        ok: true,
        result: {
          token: "attacker-scoped-token",
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    listeners[0]!({
      source: parent,
      origin: parentOrigin,
      data: {
        source: "stella-interior-parent-v1",
        v: 1,
        nonce,
        id,
        ok: true,
        result: { token: "valid-scoped-token", expiresAt: Date.now() + 60_000 },
      },
    });
    await expect(tokenPromise).resolves.toMatchObject({
      token: "valid-scoped-token",
    });
  });

  test("contains no browser auth storage or reusable bearer surface", () => {
    const source = createInteriorBridgeRuntimeSource({
      parentOrigin: "https://apps.example.test",
      gatewayOrigin: "https://apps-auth.example.test",
    });
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("better-auth");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("document.");
    expect(source).not.toContain("window.name");
    expect(source).not.toContain("bootstrap");
  });
});
