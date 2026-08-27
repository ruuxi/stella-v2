import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const contractsRoot = path.join(repoRoot, "packages/contracts");

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

const resolveContractsModule = (specifier: string): string | null => {
  if (specifier === "@stella/contracts") {
    return path.join(contractsRoot, "index.ts");
  }
  const subpath = specifier.startsWith("@stella/contracts/")
    ? specifier.slice("@stella/contracts/".length)
    : null;
  if (!subpath) return null;
  const candidates = [
    path.join(contractsRoot, `${subpath}.ts`),
    path.join(contractsRoot, `${subpath}.js`),
    path.join(contractsRoot, subpath, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const collectExportedNames = (
  file: string,
  seen = new Set<string>(),
): Set<string> => {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);

  const source = parse(file);
  for (const statement of source.statements) {
    const isExported = (statement.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      isExported &&
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement))
    ) {
      if (statement.name) names.add(statement.name.text);
      continue;
    }
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;

    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const target = moduleSpecifier.text.startsWith(".")
      ? [
          path.resolve(path.dirname(file), moduleSpecifier.text),
          `${path.resolve(path.dirname(file), moduleSpecifier.text.replace(/\.js$/, ""))}.ts`,
        ].find((candidate) => existsSync(candidate))
      : resolveContractsModule(moduleSpecifier.text);
    if (target) {
      for (const name of collectExportedNames(target, seen)) names.add(name);
    }
  }
  return names;
};

describe("electron.d.ts contract imports", () => {
  it("imports only names the contracts package still exports", () => {
    const file = path.join(
      repoRoot,
      "packages/desktop-ui/src/shared/types/electron.d.ts",
    );
    const source = parse(file);
    const dangling: string[] = [];
    let checkedImports = 0;

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith("@stella/contracts")) continue;

      const target = resolveContractsModule(specifier.text);
      expect(target, `unresolved module ${specifier.text}`).not.toBeNull();

      const clause = statement.importClause?.namedBindings;
      if (!clause || !ts.isNamedImports(clause)) continue;
      const exported = collectExportedNames(target as string);
      for (const element of clause.elements) {
        checkedImports += 1;
        const imported = (element.propertyName ?? element.name).text;
        if (!exported.has(imported)) {
          dangling.push(`${imported} (from ${specifier.text})`);
        }
      }
    }

    expect(checkedImports).toBeGreaterThan(20);
    expect(dangling).toEqual([]);
  });
});
