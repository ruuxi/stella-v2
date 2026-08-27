import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = import.meta.dirname;
const repoRootDir = path.resolve(scriptDir, "..", "..", "..");
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

const walkFiles = (rootDir) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (
        entry.isFile() &&
        sourceExtensions.has(path.extname(entry.name))
      ) {
        files.push(entryPath);
      }
    }
  };
  visit(rootDir);
  return files;
};

const resolveLocalJavaScriptSpecifier = (importerPath, specifier) => {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return null;
  }
  const directPath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    directPath,
    directPath.slice(0, -3) + ".ts",
    directPath.slice(0, -3) + ".tsx",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const hasModifier = (node, syntaxKind) =>
  node.modifiers?.some((modifier) => modifier.kind === syntaxKind) ?? false;

const addBindingNames = (name, names) => {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      addBindingNames(element.name, names);
    }
  }
};

const collectStaticExports = (sourceFile) => {
  const names = new Set();
  let skipValidation = false;

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.exportClause) {

      skipValidation = true;
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      if (statement.isTypeOnly) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          names.add(element.name.text);
        }
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, names);
      }
    }
  }

  return { names, skipValidation };
};

const isCommonJsSource = (sourceText) =>
  /\bmodule\.exports\b|\bexports\s*\./.test(sourceText);

export const collectLocalNamedImportErrors = ({ sourceFiles }) => {
  const errors = [];
  const exportCache = new Map();

  const readExports = (targetPath) => {
    const cached = exportCache.get(targetPath);
    if (cached) {
      return cached;
    }
    const sourceText = readFileSync(targetPath, "utf8");
    if (isCommonJsSource(sourceText)) {
      const result = { names: new Set(), skipValidation: true };
      exportCache.set(targetPath, result);
      return result;
    }
    const scriptKind = targetPath.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      targetPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const result = collectStaticExports(sourceFile);
    exportCache.set(targetPath, result);
    return result;
  };

  for (const sourcePath of sourceFiles) {
    const sourceText = readFileSync(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      sourcePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const targetPath = resolveLocalJavaScriptSpecifier(sourcePath, specifier);
      if (!targetPath) {
        continue;
      }
      const exports = readExports(targetPath);
      if (exports.skipValidation) {
        continue;
      }
      for (const element of statement.importClause.namedBindings.elements) {
        if (statement.importClause.isTypeOnly || element.isTypeOnly) {
          continue;
        }
        const importedName = (element.propertyName ?? element.name).text;
        if (!exports.names.has(importedName)) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            element.getStart(sourceFile),
          );
          errors.push({
            sourcePath,
            targetPath,
            specifier,
            importedName,
            line: position.line + 1,
            column: position.character + 1,
          });
        }
      }
    }
  }

  return errors;
};

export const verifyLocalNamedImports = ({ rootDir = repoRootDir } = {}) => {
  const sourceFiles = [
    ...walkFiles(path.join(rootDir, "packages", "runtime")),
    ...walkFiles(path.join(rootDir, "packages", "desktop", "electron")),
  ];
  const errors = collectLocalNamedImportErrors({ sourceFiles });
  if (errors.length > 0) {
    throw new Error(
      `Local named-import verification failed:\n${errors
        .map(
          ({ sourcePath, specifier, importedName, line, column }) =>
            `- ${path.relative(rootDir, sourcePath)}:${line}:${column} imports missing ` +
            `'${importedName}' from ${specifier}`,
        )
        .join("\n")}`,
    );
  }
  return sourceFiles.length;
};

const isRunDirectly = (() => {
  try {
    return (
      path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isRunDirectly) {
  try {
    const count = verifyLocalNamedImports();
    console.log(
      `[verify-local-named-imports] ${count} local source file(s) have valid static named imports.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
