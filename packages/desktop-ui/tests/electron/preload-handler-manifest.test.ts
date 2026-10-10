import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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

const parseTsFile = (filePath: string): ts.SourceFile =>
  ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

const contractsDir = path.join(repoRoot, "packages/contracts/desktop");

/** `IPC_*` constant name -> channel string, from the shared channel list. */
const sharedChannelIdentifiers = (): Map<string, string> =>
  collectStaticChannelValues(
    parseTsFile(path.join(contractsDir, "ipc-channels.ts")),
  ).identifiers;

/**
 * Every invoke channel the typed contract declares: the keys of
 * `IpcInvokeContract`. The preload bridge can only `ipc.invoke` these (the
 * `TypedIpcRenderer` signature takes `keyof IpcInvokeContract`), so this is
 * the full set of channels the renderer can call.
 */
const collectContractInvokeChannels = (
  sharedIdentifiers: Map<string, string>,
): Set<string> => {
  const sourceFile = parseTsFile(path.join(contractsDir, "ipc-contract.ts"));
  const contract = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "IpcInvokeContract",
  );
  if (!contract || !ts.isTypeLiteralNode(contract.type)) {
    throw new Error(
      "IpcInvokeContract is not a type literal in ipc-contract.ts",
    );
  }
  const channels = new Set<string>();
  for (const member of contract.type.members) {
    const name = member.name;
    if (!name) continue;
    let channel: string | null = null;
    if (ts.isStringLiteral(name)) {
      channel = name.text;
    } else if (ts.isComputedPropertyName(name)) {
      channel = resolveStaticChannel(
        name.expression,
        { identifiers: new Map(), objectProperties: new Map() },
        sharedIdentifiers,
      );
    }
    if (!channel) {
      throw new Error(
        `Cannot resolve IpcInvokeContract key ${name.getText(sourceFile)} to a channel string`,
      );
    }
    channels.add(channel);
  }
  return channels;
};

/**
 * Invoke channels `createElectronApi` (the preload bridge) actually calls,
 * through `invoker(CHANNEL)` or `ipc.invoke(CHANNEL, ...)`.
 */
const collectBridgeInvokeChannels = (
  sharedIdentifiers: Map<string, string>,
): Set<string> => {
  const sourceFile = parseTsFile(path.join(contractsDir, "electron-api.ts"));
  const values = collectStaticChannelValues(sourceFile);
  const channels = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression;
      const isInvoker = ts.isIdentifier(callee) && callee.text === "invoker";
      const isIpcInvoke =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "ipc" &&
        callee.name.text === "invoke";
      if (isInvoker || isIpcInvoke) {
        const channel = resolveStaticChannel(
          node.arguments[0],
          values,
          sharedIdentifiers,
        );
        if (channel) channels.add(channel);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return channels;
};

const collectRegisteredInvokeHandlers = (
  sharedIdentifiers: Map<string, string>,
): Set<string> => {
  const channels = new Set<string>();
  const electronRoot = path.join(repoRoot, "packages/desktop/electron");

  for (const sourcePath of walkSourceFiles(electronRoot)) {
    if (sourcePath.endsWith("preload.ts")) continue;
    const sourceFile = parseTsFile(sourcePath);
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
        node.expression.text === "handleIpc"
      ) {
        // The typed `ipcMain.handle` wrapper (`electron/ipc/typed-ipc.ts`).
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
  const sharedIdentifiers = sharedChannelIdentifiers();
  const contractInvokes = collectContractInvokeChannels(sharedIdentifiers);

  it("reads the invoke channels from the typed contract", () => {
    // Guards against the manifest going vacuous if the contract's shape moves.
    expect(sharedIdentifiers.size).toBeGreaterThan(0);
    expect(contractInvokes.size).toBeGreaterThan(0);
  });

  it("only invokes contract channels from the preload bridge", () => {
    const bridgeInvokes = collectBridgeInvokeChannels(sharedIdentifiers);
    expect(bridgeInvokes.size).toBeGreaterThan(0);
    const outsideContract = [...bridgeInvokes]
      .filter((channel) => !contractInvokes.has(channel))
      .sort();

    expect(outsideContract).toEqual([]);
  });

  it("registers a main-process handler for every contract invoke channel", () => {
    const registeredHandlers =
      collectRegisteredInvokeHandlers(sharedIdentifiers);
    const missing = [...contractInvokes]
      .filter((channel) => !registeredHandlers.has(channel))
      .sort();

    expect(missing).toEqual([]);
  });
});
