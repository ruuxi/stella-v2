#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const PRELOAD = path.join(desktopDir, "electron/preload.ts");
const CHANNELS = path.resolve(
  desktopDir,
  "../contracts/desktop/ipc-channels.ts",
);
const OUTPUT = path.join(
  desktopDir,
  "electron/services/mobile-bridge/ipc-payload-contract.generated.js",
);

const parse = (file) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

function readChannelConstants(source) {
  const constants = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      let initializer = node.initializer;
      while (initializer && ts.isAsExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (initializer && ts.isStringLiteral(initializer)) {
        constants.set(node.name.text, initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

function findForwardingWrappers(source) {
  const wrappers = new Map();

  const inspect = (name, fn) => {
    if (!fn?.body || !fn.parameters?.length) return;
    const paramIndex = new Map();
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        paramIndex.set(parameter.name.text, index);
      }
    });

    let found = null;
    const walk = (node) => {
      if (found) return;
      if (isIpcRendererCall(node) && node.arguments.length >= 1) {
        const channelArg = node.arguments[0];
        const payloadArg = node.arguments[1];
        if (
          ts.isIdentifier(channelArg) &&
          paramIndex.has(channelArg.text) &&
          payloadArg &&
          ts.isIdentifier(payloadArg) &&
          paramIndex.has(payloadArg.text)
        ) {
          found = {
            channelIndex: paramIndex.get(channelArg.text),
            payloadIndex: paramIndex.get(payloadArg.text),
          };
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(fn.body);
    if (found) wrappers.set(name, found);
  };

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      inspect(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      inspect(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return wrappers;
}

function isIpcRendererCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "ipcRenderer" &&
    (node.expression.name.text === "invoke" ||
      node.expression.name.text === "send")
  );
}

function describePayload(argument) {
  if (!argument) return { kind: "none" };
  if (ts.isObjectLiteralExpression(argument)) {
    const fields = [];
    for (const property of argument.properties) {

      if (ts.isSpreadAssignment(property)) return { kind: "passthrough" };
      const name = property.name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        fields.push(name.text);
      } else {
        return { kind: "passthrough" };
      }
    }
    return { kind: "object", fields };
  }

  return { kind: "passthrough" };
}

function sameContract(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "object") return true;
  return (
    a.fields.length === b.fields.length &&
    a.fields.every((field, index) => field === b.fields[index])
  );
}

function deriveContract() {
  const constants = readChannelConstants(parse(CHANNELS));
  const preload = parse(PRELOAD);

  for (const [name, value] of readChannelConstants(preload)) {
    if (!constants.has(name)) constants.set(name, value);
  }

  const wrappers = findForwardingWrappers(preload);
  const contracts = new Map();
  const conflicts = [];

  const resolveChannel = (argument) => {
    if (!argument) return null;
    if (ts.isStringLiteral(argument)) return argument.text;
    if (ts.isIdentifier(argument)) return constants.get(argument.text) ?? null;
    return null;
  };

  const record = (channel, contract, node) => {
    const existing = contracts.get(channel);
    if (existing && !sameContract(existing, contract)) {
      const { line } = preload.getLineAndCharacterOfPosition(node.getStart());
      conflicts.push(
        `${channel}: ${JSON.stringify(existing)} vs ${JSON.stringify(contract)} (preload.ts:${line + 1})`,
      );
      return;
    }
    contracts.set(channel, contract);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (isIpcRendererCall(node)) {
        const channel = resolveChannel(node.arguments[0]);
        if (channel) record(channel, describePayload(node.arguments[1]), node);
      } else if (ts.isIdentifier(node.expression)) {
        const wrapper = wrappers.get(node.expression.text);
        if (wrapper) {
          const channel = resolveChannel(node.arguments[wrapper.channelIndex]);
          if (channel) {
            record(
              channel,
              describePayload(node.arguments[wrapper.payloadIndex]),
              node,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(preload);

  if (conflicts.length > 0) {
    throw new Error(
      `preload.ts invokes the same channel with different payload shapes:\n  ${conflicts.join("\n  ")}`,
    );
  }
  return contracts;
}

function render(contracts) {
  const entries = [...contracts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const body = entries
    .map(([channel, contract]) => {
      const value =
        contract.kind === "object"
          ? `{ kind: "object", fields: [${contract.fields.map((field) => JSON.stringify(field)).join(", ")}] }`
          : `{ kind: "${contract.kind}" }`;
      return `    ${JSON.stringify(channel)}: ${value},`;
    })
    .join("\n");

  return `// Generated by scripts/derive-ipc-payload-contract.mjs — do not edit.

export const IPC_PAYLOAD_CONTRACT = {
${body}
};
`;
}

const contracts = deriveContract();
const rendered = render(contracts);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (current !== rendered) {
    console.error(
      "ipc-payload-contract.generated.js is stale. Run: node scripts/derive-ipc-payload-contract.mjs",
    );
    process.exit(1);
  }
  console.log(`ipc payload contract is current (${contracts.size} channels).`);
} else {
  fs.writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${contracts.size} channel contracts to ${OUTPUT}`);
}
