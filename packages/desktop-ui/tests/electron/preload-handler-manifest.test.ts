import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildMobileBridgeCapabilityManifest } from "../../../desktop/electron/services/mobile-bridge/capabilities.js";
import { IPC_PAYLOAD_CONTRACT } from "../../../desktop/electron/services/mobile-bridge/ipc-payload-contract.generated.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

const walkSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(entryPath);
    return entry.isFile() && /\.(?:js|ts)$/.test(entry.name) ? [entryPath] : [];
  });

type StaticChannelValues = {
  identifiers: Map<string, string>;
  objectProperties: Map<string, Map<string, string>>;
};

const collectStaticChannelValues = (
  sourceFile: ts.SourceFile,
): StaticChannelValues => {
  const identifiers = new Map<string, string>();
  const objectProperties = new Map<string, Map<string, string>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const initializer = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (ts.isStringLiteral(initializer)) {
        identifiers.set(declaration.name.text, initializer.text);
        continue;
      }
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      const properties = new Map<string, string>();
      for (const property of initializer.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.initializer)
        ) {
          continue;
        }
        const name = ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : null;
        if (name) properties.set(name, property.initializer.text);
      }
      objectProperties.set(declaration.name.text, properties);
    }
  }
  return { identifiers, objectProperties };
};

const resolveStaticChannel = (
  expression: ts.Expression,
  values: StaticChannelValues,
  sharedIdentifiers: Map<string, string>,
): string | null => {
  if (ts.isStringLiteral(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    return (
      values.identifiers.get(expression.text) ??
      sharedIdentifiers.get(expression.text) ??
      null
    );
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    return (
      values.objectProperties
        .get(expression.expression.text)
        ?.get(expression.name.text) ?? null
    );
  }
  return null;
};

const collectPreloadInvokes = (preloadPath: string): Set<string> => {
  const sourceFile = ts.createSourceFile(
    preloadPath,
    readFileSync(preloadPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const channels = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ipcRenderer" &&
      node.expression.name.text === "invoke" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      channels.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return channels;
};

const collectRegisteredInvokeHandlers = (): Set<string> => {
  const contractsPath = path.join(
    repoRoot,
    "packages/contracts/desktop/ipc-channels.ts",
  );
  const contractsSource = ts.createSourceFile(
    contractsPath,
    readFileSync(contractsPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sharedIdentifiers =
    collectStaticChannelValues(contractsSource).identifiers;
  const channels = new Set<string>();
  const electronRoot = path.join(repoRoot, "packages/desktop/electron");

  for (const sourcePath of walkSourceFiles(electronRoot)) {
    if (sourcePath.endsWith("preload.ts")) continue;
    const sourceFile = ts.createSourceFile(
      sourcePath,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      sourcePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const values = collectStaticChannelValues(sourceFile);
    const visit = (node: ts.Node) => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      let channelExpression: ts.Expression | undefined;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "ipcMain" &&
        node.expression.name.text === "handle"
      ) {
        channelExpression = node.arguments[0];
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "registerPrivilegedHandle"
      ) {
        channelExpression = node.arguments[1];
      } else if (
        sourcePath.endsWith("in-app-browser-handlers.ts") &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "register"
      ) {
        channelExpression = node.arguments[0];
      }
      if (channelExpression) {
        const channel = resolveStaticChannel(
          channelExpression,
          values,
          sharedIdentifiers,
        );
        if (channel) channels.add(channel);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return channels;
};

describe("preload IPC handler manifest", () => {
  it("builds payload-bearing capabilities from the generated contract", () => {
    const manifest = buildMobileBridgeCapabilityManifest();
    expect(manifest.version).toBe(1);
    expect(
      manifest.capabilities.find(
        (capability) => capability.path === "browser.fetchJson",
      ),
    ).toMatchObject({
      channel: "browser:fetchJson",
      payload: { kind: "object", fields: ["url", "init"] },
    });
  });

  it("keeps dead window-attach and dictation trigger invokes out of preload", () => {
    const preload = readFileSync(
      path.join(repoRoot, "packages/desktop/electron/preload.ts"),
      "utf8",
    );
    const electronTypes = readFileSync(
      path.join(repoRoot, "packages/desktop-ui/src/shared/types/electron.d.ts"),
      "utf8",
    );
    const rendererChannels = readFileSync(
      path.join(
        repoRoot,
        "packages/desktop-ui/src/shared/contracts/ipc-channels.ts",
      ),
      "utf8",
    );
    const contractChannels = readFileSync(
      path.join(repoRoot, "packages/contracts/desktop/ipc-channels.ts"),
      "utf8",
    );

    expect(preload).not.toContain('invoke("capture:beginWindowAttach")');
    expect(preload).not.toContain('invoke("dictation:trigger")');
    expect(preload).not.toContain('send("windowAttach:click"');
    expect(preload).not.toContain('send("windowAttach:cancel"');
    expect(electronTypes).not.toContain(
      "trigger: () => Promise<{ ok: boolean }>;",
    );
    expect(electronTypes).not.toContain(
      "Programmatically trigger the same toggle",
    );
    expect(rendererChannels).not.toContain("IPC_DICTATION_TRIGGER");
    expect(contractChannels).not.toContain("IPC_DICTATION_TRIGGER");
    expect(IPC_PAYLOAD_CONTRACT).not.toHaveProperty(
      "capture:beginWindowAttach",
    );
    expect(IPC_PAYLOAD_CONTRACT).not.toHaveProperty("dictation:trigger");
  });

  it("keeps the removed morph, Store and Social surfaces out of the IPC contract", () => {
    const preload = readFileSync(
      path.join(repoRoot, "packages/desktop/electron/preload.ts"),
      "utf8",
    );
    const rendererChannels = readFileSync(
      path.join(
        repoRoot,
        "packages/desktop-ui/src/shared/contracts/ipc-channels.ts",
      ),
      "utf8",
    );
    const contractChannels = readFileSync(
      path.join(repoRoot, "packages/contracts/desktop/ipc-channels.ts"),
      "utf8",
    );

    for (const source of [preload, rendererChannels, contractChannels]) {
      expect(source).not.toMatch(/morph/i);
      expect(source).not.toContain("storeWeb");
      expect(source).not.toContain("socialSessions");
      expect(source).not.toContain("social:invite");
      expect(source).not.toContain("store:listPackages");
    }

    for (const channel of [
      "morph:start",
      "morph:complete",
      "overlay:morphReady",
      "overlay:morphDone",
      "storeWeb:getEmbedConfig",
      "store:listPackages",
      "store:getPackage",
      "store:listReleases",
      "store:getRelease",
      "socialSessions:create",
      "socialSessions:updateStatus",
      "socialSessions:queueTurn",
      "socialSessions:getStatus",
      "social:consumePendingInvite",
    ]) {
      expect(IPC_PAYLOAD_CONTRACT).not.toHaveProperty(channel);
    }

    expect(IPC_PAYLOAD_CONTRACT).toHaveProperty("theme:listInstalled");
    expect(IPC_PAYLOAD_CONTRACT).toHaveProperty("website:getBaseUrl");
  });

  it("never passes an IPC channel constant as an IPC payload", () => {

    const preloadPath = path.join(
      repoRoot,
      "packages/desktop/electron/preload.ts",
    );
    const sourceFile = ts.createSourceFile(
      preloadPath,
      readFileSync(preloadPath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const contractsSource = ts.createSourceFile(
      path.join(repoRoot, "packages/contracts/desktop/ipc-channels.ts"),
      readFileSync(
        path.join(repoRoot, "packages/contracts/desktop/ipc-channels.ts"),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const channelIdentifiers =
      collectStaticChannelValues(contractsSource).identifiers;

    const offenders: string[] = [];
    let inspectedCalls = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "ipcRenderer" &&
        ["invoke", "send", "sendSync", "on", "off"].includes(
          node.expression.name.text,
        )
      ) {
        inspectedCalls += 1;
        for (const argument of node.arguments.slice(1)) {
          const isChannelConstant =
            ts.isIdentifier(argument) && channelIdentifiers.has(argument.text);
          const isChannelLiteral =
            ts.isStringLiteral(argument) &&
            [...channelIdentifiers.values()].includes(argument.text);
          if (isChannelConstant || isChannelLiteral) {
            offenders.push(
              `${node.expression.name.text}(... , ${argument.getText()})`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(inspectedCalls).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("registers a main-process handler for every preload invoke channel", () => {
    const preloadInvokes = collectPreloadInvokes(
      path.join(repoRoot, "packages/desktop/electron/preload.ts"),
    );
    const registeredHandlers = collectRegisteredInvokeHandlers();
    const missing = [...preloadInvokes]
      .filter((channel) => !registeredHandlers.has(channel))
      .sort();

    expect(missing).toEqual([]);
  });
});
