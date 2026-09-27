/**
 * Decides, from a parsed script, whether the worker shell may run it.
 *
 * The analysis runs as a just-bash transform plugin, so it sees every script
 * the interpreter parses through `exec`: the command the model sent, and every
 * command another command builds at runtime (`xargs`, `find -exec`,
 * `timeout`, `env`, awk's `system()` and pipes, `rg --pre`, `$(( $(…) ))`).
 * A refusal therefore lands before the refused code runs, wherever it came
 * from. Whatever still escapes a parse (a workspace file resolved as a
 * script, a name no registered command answers) is caught by the dispatch
 * hooks the bundle build installs, and the transaction guarantees a refusal
 * at any point leaves the world untouched.
 *
 * The rules refuse three kinds of script:
 * - ones that need something only a real system has: a program just-bash
 *   does not implement, a file run as a program, a background job;
 * - ones whose answer would describe this lightweight shell instead of the
 *   sandbox the model believes it is using (`which`, `command -v`, `type`,
 *   printing the whole environment);
 * - ones that could make a later command resolve to a workspace file
 *   (changing PATH, `hash -p`, aliases, `eval`, `source`).
 */

import type {
  ScriptNode,
  SimpleCommandNode,
  WordNode,
} from "just-bash";
import type { WorkerShellFallbackReason } from "./protocol.js";

export type WorkerShellEligibility =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason: WorkerShellFallbackReason;
      detail: string;
    }>;

/**
 * just-bash commands whose output does not depend on the host they run on.
 * Anything else is refused and runs in the sandbox, including just-bash
 * commands that would answer for the wrong machine (`which`, `hostname`,
 * `whoami`, `printenv`) or need a runtime the shell does not load.
 */
export const WORKER_SHELL_COMMANDS = [
  "awk",
  "base64",
  "basename",
  "cat",
  "chmod",
  "column",
  "comm",
  "cp",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "egrep",
  "env",
  "expand",
  "expr",
  "false",
  "fgrep",
  "file",
  "find",
  "fold",
  "grep",
  "gunzip",
  "gzip",
  "head",
  "jq",
  "join",
  "ln",
  "ls",
  "md5sum",
  "mkdir",
  "mv",
  "nl",
  "od",
  "paste",
  "printf",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sha1sum",
  "sha256sum",
  "sleep",
  "sort",
  "split",
  "stat",
  "strings",
  "tac",
  "tail",
  "tar",
  "tee",
  "time",
  "timeout",
  "touch",
  "tr",
  "tree",
  "true",
  "unexpand",
  "uniq",
  "wc",
  "xan",
  "xargs",
  "yq",
  "zcat",
] as const;

const COMMANDS: ReadonlySet<string> = new Set(WORKER_SHELL_COMMANDS);

/** Interpreter builtins whose behavior matches bash for the model's purposes. */
const BUILTINS: ReadonlySet<string> = new Set([
  ":",
  "[",
  "break",
  "builtin",
  "cd",
  "command",
  "continue",
  "declare",
  "dirs",
  "exit",
  "export",
  "getopts",
  "let",
  "local",
  "mapfile",
  "popd",
  "pushd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "test",
  "typeset",
  "unset",
]);

/** Builtins that bind a variable named by an argument. */
const BINDING_BUILTINS: ReadonlySet<string> = new Set([
  "declare",
  "export",
  "local",
  "mapfile",
  "read",
  "readarray",
  "readonly",
  "typeset",
]);

const refuse = (
  reason: WorkerShellFallbackReason,
  detail: string,
): WorkerShellEligibility => ({ ok: false, reason, detail });

const OK: WorkerShellEligibility = { ok: true };

type Part = WordNode["parts"][number];

/** A word's value when it has no expansion at all, otherwise null. */
export const staticWordValue = (word: WordNode): string | null => {
  let value = "";
  const append = (parts: readonly Part[]): boolean => {
    for (const part of parts) {
      switch (part.type) {
        case "Literal":
        case "SingleQuoted":
        case "Escaped":
          value += part.value;
          break;
        case "DoubleQuoted":
          if (!append(part.parts)) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  };
  return append(word.parts) ? value : null;
};

/**
 * The literal text before a word's first expansion. `FOO=$x` has the static
 * prefix `FOO=`, which is all a binding builtin needs to know which variable
 * the word names.
 */
const staticWordPrefix = (word: WordNode): string => {
  let value = "";
  const append = (parts: readonly Part[]): boolean => {
    for (const part of parts) {
      switch (part.type) {
        case "Literal":
        case "SingleQuoted":
        case "Escaped":
          value += part.value;
          break;
        case "DoubleQuoted":
          if (!append(part.parts)) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  };
  append(word.parts);
  return value;
};

const isOption = (value: string | null): boolean =>
  value !== null && value.startsWith("-") && value !== "-";

const namesPath = (name: string): boolean => name === "PATH";

/**
 * The variable a binding-builtin argument names, or null when that cannot be
 * known before it runs.
 */
const boundName = (word: WordNode): string | null => {
  const exact = staticWordValue(word);
  const text = exact ?? staticWordPrefix(word);
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/u.exec(text);
  if (assignment) return assignment[1]!;
  if (exact !== null) return exact;
  return null;
};

const checkBindingBuiltin = (
  name: string,
  args: readonly WordNode[],
): WorkerShellEligibility => {
  const values = args.map(staticWordValue);
  if (
    (name === "declare" || name === "typeset" || name === "local") &&
    values.some((value) => isOption(value) && /n/u.test(value!.slice(1)))
  ) {
    return refuse("unsupported_syntax", `${name} -n creates a name reference`);
  }
  if (
    (name === "mapfile" || name === "readarray") &&
    values.some((value) => isOption(value) && /C/u.test(value!.slice(1)))
  ) {
    return refuse("unsupported_syntax", `${name} -C runs a callback`);
  }
  const printsEverything = args.every((word, index) =>
    isOption(values[index] ?? null),
  );
  if (
    printsEverything &&
    (name === "export" ||
      name === "declare" ||
      name === "typeset" ||
      name === "readonly") &&
    !values.some((value) => value === "-f" || value === "-F")
  ) {
    return refuse(
      "unsupported_command",
      `${name} without names prints the shell's environment`,
    );
  }
  for (const [index, word] of args.entries()) {
    const value = values[index] ?? null;
    if (isOption(value)) continue;
    const bound = boundName(word);
    if (bound === null) {
      return refuse(
        "unsupported_syntax",
        `${name} binds a variable whose name is computed at runtime`,
      );
    }
    if (namesPath(bound)) {
      return refuse("unsupported_syntax", `${name} changes PATH`);
    }
  }
  return OK;
};

export type WorkerShellAnalysis = Readonly<{
  /** Functions the script defines; calling one is always allowed. */
  functions: ReadonlySet<string>;
}>;

const checkCommandName = (
  name: string,
  args: readonly WordNode[],
  analysis: WorkerShellAnalysis,
): WorkerShellEligibility => {
  if (name.includes("/")) {
    return refuse("unsupported_command", `${name} runs a file as a program`);
  }
  if (analysis.functions.has(name)) return OK;
  if (name === "command" || name === "builtin") {
    const values = args.map(staticWordValue);
    let index = 0;
    while (index < values.length && isOption(values[index] ?? null)) {
      const option = values[index]!;
      if (option === "--") {
        index += 1;
        break;
      }
      if (/[vV]/u.test(option.slice(1))) {
        return refuse(
          "unsupported_command",
          `${name} ${option} reports on this shell's commands, not the sandbox's`,
        );
      }
      index += 1;
    }
    const inner = args[index];
    if (!inner) return OK;
    const innerName = values[index];
    if (innerName === null || innerName === undefined) {
      return refuse(
        "unsupported_syntax",
        `${name} runs a command whose name is computed at runtime`,
      );
    }
    return checkCommandName(innerName, args.slice(index + 1), analysis);
  }
  if (name === "printf") {
    const values = args.map(staticWordValue);
    const target = values.indexOf("-v");
    if (target >= 0) {
      const word = args[target + 1];
      const bound = word ? boundName(word) : null;
      if (bound === null) {
        return refuse(
          "unsupported_syntax",
          "printf -v binds a variable whose name is computed at runtime",
        );
      }
      if (namesPath(bound)) {
        return refuse("unsupported_syntax", "printf -v changes PATH");
      }
    }
    return OK;
  }
  if (name === "set" && args.length === 0) {
    return refuse(
      "unsupported_command",
      "set without arguments prints the shell's variables",
    );
  }
  if (name === "env") {
    // `env` alone prints this shell's environment. With a command, just-bash
    // runs it through `exec`, where this analysis sees it again.
    const values = args.map(staticWordValue);
    let index = 0;
    while (index < values.length) {
      const value = values[index];
      if (value === null || value === undefined) {
        return refuse(
          "unsupported_syntax",
          "env runs a command whose name is computed at runtime",
        );
      }
      if (value === "-S" || value.startsWith("--split-string")) {
        return refuse("unsupported_syntax", "env -S splits a command string");
      }
      if (value === "-u" || value === "-C" || value === "--chdir") {
        index += 2;
        continue;
      }
      if (isOption(value)) {
        index += 1;
        continue;
      }
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(value);
      if (assignment) {
        if (namesPath(assignment[1]!)) {
          return refuse("unsupported_syntax", "env changes PATH");
        }
        index += 1;
        continue;
      }
      return OK;
    }
    return refuse(
      "unsupported_command",
      "env without a command prints the shell's environment",
    );
  }
  if (BINDING_BUILTINS.has(name)) return checkBindingBuiltin(name, args);
  if (BUILTINS.has(name) || COMMANDS.has(name)) return OK;
  return refuse(
    "unsupported_command",
    `${name} is not available in the lightweight shell`,
  );
};

const checkSimpleCommand = (
  node: SimpleCommandNode,
  analysis: WorkerShellAnalysis,
): WorkerShellEligibility => {
  for (const assignment of node.assignments) {
    if (namesPath(assignment.name)) {
      return refuse("unsupported_syntax", "the script changes PATH");
    }
  }
  if (!node.name) return OK;
  const name = staticWordValue(node.name);
  if (name === null) {
    return refuse(
      "unsupported_syntax",
      "a command name is computed at runtime",
    );
  }
  return checkCommandName(name, node.args, analysis);
};

const isNode = (value: unknown): value is { type: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/**
 * Walk every object in the tree rather than enumerating node kinds. A node
 * kind a later just-bash adds is then still searched for the commands and
 * expansions inside it, instead of being silently skipped.
 */
const walk = (root: unknown, visit: (node: { type: string }) => boolean) => {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (isNode(value) && !visit(value)) return false;
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  return true;
};

const RUNTIME_CODE_PATTERN = /\$\(|`/u;

export const analyzeWorkerShellScript = (
  script: ScriptNode,
): WorkerShellEligibility => {
  const functions = new Set<string>();
  walk(script, (node) => {
    if (node.type === "FunctionDef") {
      functions.add((node as unknown as { name: string }).name);
    }
    return true;
  });
  const analysis: WorkerShellAnalysis = { functions };
  let verdict: WorkerShellEligibility = OK;
  walk(script, (node) => {
    switch (node.type) {
      case "Statement":
        if ((node as unknown as { background: boolean }).background) {
          verdict = refuse(
            "unsupported_syntax",
            "a background job needs a real process",
          );
          return false;
        }
        return true;
      case "SimpleCommand":
        verdict = checkSimpleCommand(
          node as unknown as SimpleCommandNode,
          analysis,
        );
        return verdict.ok;
      case "ArithBracedExpansion": {
        // `$(( ${x:-$(cmd)} ))` keeps its braces as text and runs them later
        // without a parse this analysis sees.
        const content = (node as unknown as { content: string }).content;
        if (RUNTIME_CODE_PATTERN.test(content)) {
          verdict = refuse(
            "unsupported_syntax",
            "an arithmetic expansion embeds a command",
          );
          return false;
        }
        return true;
      }
      case "Assignment":
      case "ArithAssignment": {
        const name = (node as unknown as { name?: unknown; variable?: unknown })
          .name;
        const variable = (node as unknown as { variable?: unknown }).variable;
        if (name === "PATH" || variable === "PATH") {
          verdict = refuse("unsupported_syntax", "the script changes PATH");
          return false;
        }
        return true;
      }
      default:
        return true;
    }
  });
  return verdict;
};
