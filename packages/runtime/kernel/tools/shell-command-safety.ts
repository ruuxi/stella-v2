import os from "node:os";
import path from "node:path";

type ShellToken =
  | { kind: "word"; value: string }
  | { kind: "operator"; value: string };

type LexedShell = {
  tokens: ShellToken[];
  nestedCommands: string[];
  staticExpressions: Map<string, string>;
};

type CriticalPathKind = "root" | "system" | "home" | "volume" | "raw-device";

type AnalysisState = {
  cwd: string;
  variables: Map<string, string>;
};

const MAX_NESTED_COMMAND_DEPTH = 8;

const UNIX_SYSTEM_ROOTS = new Set([
  "/applications",
  "/bin",
  "/boot",
  "/etc",
  "/home",
  "/lib",
  "/library",
  "/mnt",
  "/private",
  "/root",
  "/sbin",
  "/system",
  "/users",
  "/usr",
  "/var",
  "/volumes",
]);

const WINDOWS_SYSTEM_ROOT_SUFFIXES = new Set([
  "/program files",
  "/program files (x86)",
  "/programdata",
  "/users",
  "/windows",
]);

const RAW_UNIX_DEVICE_PATTERN =
  /^\/dev\/(?:block\/\d+:\d+|mapper\/[^/]+|r?disk\d+(?:s\d+)?|sd[a-z]\d*|hd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|loop\d+)$/iu;

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function pushWord(tokens: ShellToken[], value: string, started: boolean): void {
  if (started) tokens.push({ kind: "word", value });
}

function readBalancedCommand(
  input: string,
  contentStart: number,
): { content: string; end: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = contentStart; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { content: input.slice(contentStart, index), end: index };
      }
    }
  }
  return null;
}

function readBacktickCommand(
  input: string,
  contentStart: number,
): { content: string; end: number } | null {
  let escaped = false;
  for (let index = contentStart; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      return { content: input.slice(contentStart, index), end: index };
    }
  }
  return null;
}

/**
 * A deliberately small shell lexer. It is not used to execute or rewrite the
 * command; it only separates actual command positions from inert quoted text.
 * Unknown or incomplete syntax is left as ordinary words rather than guessed.
 */
function lexShell(input: string): LexedShell {
  const tokens: ShellToken[] = [];
  const nestedCommands: string[] = [];
  const staticExpressions = new Map<string, string>();
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    pushWord(tokens, word, wordStarted);
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (!quote && char === "#" && !wordStarted) {
      flushWord();
      while (index < input.length && input[index] !== "\n") index += 1;
      if (index < input.length) {
        tokens.push({ kind: "operator", value: "\n" });
      }
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      wordStarted = true;
      continue;
    }

    if (char === "`") {
      const nested = readBacktickCommand(input, index + 1);
      if (nested) {
        nestedCommands.push(nested.content);
        const placeholder = `__stella_static_${staticExpressions.size}__`;
        staticExpressions.set(placeholder, nested.content);
        word += placeholder;
        wordStarted = true;
        index = nested.end;
        continue;
      }
    }

    if (char === "$" && input[index + 1] === "(" && input[index + 2] !== "(") {
      const nested = readBalancedCommand(input, index + 2);
      if (nested) {
        nestedCommands.push(nested.content);
        const placeholder = `__stella_static_${staticExpressions.size}__`;
        staticExpressions.set(placeholder, nested.content);
        word += placeholder;
        wordStarted = true;
        index = nested.end;
        continue;
      }
    }

    if (!quote && (char === "<" || char === ">") && input[index + 1] === "(") {
      const nested = readBalancedCommand(input, index + 2);
      if (nested) {
        nestedCommands.push(nested.content);
        const placeholder = `__stella_static_${staticExpressions.size}__`;
        staticExpressions.set(placeholder, nested.content);
        word += placeholder;
        wordStarted = true;
        index = nested.end;
        continue;
      }
    }

    if (char === '"') {
      quote = quote === '"' ? null : '"';
      wordStarted = true;
      continue;
    }
    if (!quote && char === "'") {
      quote = "'";
      wordStarted = true;
      continue;
    }
    // ANSI-C and locale strings are command words, not a literal '$' prefix.
    if (
      !quote &&
      char === "$" &&
      (input[index + 1] === "'" || input[index + 1] === '"')
    ) {
      quote = input[index + 1] as "'" | '"';
      wordStarted = true;
      index += 1;
      continue;
    }

    if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined) {
        word += char;
      } else if (
        !quote &&
        /^(?:[A-Za-z]:|\/\/)/u.test(word) &&
        /\s/u.test(next)
      ) {
        // PowerShell and cmd do not use a trailing Windows path separator to
        // escape the following argument separator.
        word += char;
      } else if (quote === '"' || /[\s'"`$;&|<>(){}\\]/u.test(next)) {
        word += next;
        index += 1;
      } else {
        // Preserve Windows path separators. Executable-name matching also
        // checks a POSIX-unescaped spelling, so r\m cannot evade detection.
        word += char;
      }
      wordStarted = true;
      continue;
    }

    if (!quote && /[ \t\r]/u.test(char)) {
      flushWord();
      continue;
    }
    if (!quote && char === "(" && !wordStarted) {
      const nested = readBalancedCommand(input, index + 1);
      if (
        nested &&
        /^\s*(?:Resolve-Path|realpath|readlink|pwd)\b/iu.test(nested.content)
      ) {
        const placeholder = `__stella_static_${staticExpressions.size}__`;
        staticExpressions.set(placeholder, nested.content);
        word += placeholder;
        wordStarted = true;
        index = nested.end;
        continue;
      }
    }
    if (!quote && /[;&|\n()<>]/u.test(char)) {
      flushWord();
      let operator = char;
      if (
        (char === "&" || char === "|" || char === ">" || char === "<") &&
        input[index + 1] === char
      ) {
        operator += char;
        index += 1;
      }
      tokens.push({ kind: "operator", value: operator });
      continue;
    }

    word += char;
    wordStarted = true;
  }

  flushWord();
  return { tokens, nestedCommands, staticExpressions };
}

type ShellCommandSegment = {
  tokens: ShellToken[];
  precedingOperator?: string;
};

function splitCommandSegments(tokens: ShellToken[]): ShellCommandSegment[] {
  const commands: ShellCommandSegment[] = [];
  let current: ShellToken[] = [];
  let precedingOperator: string | undefined;
  for (const token of tokens) {
    if (
      token.kind === "operator" &&
      token.value !== ">" &&
      token.value !== ">>" &&
      token.value !== "<" &&
      token.value !== "<<"
    ) {
      if (current.length > 0) {
        commands.push({ tokens: current, precedingOperator });
      }
      current = [];
      precedingOperator = token.value;
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) commands.push({ tokens: current, precedingOperator });
  return commands;
}

function splitCommands(tokens: ShellToken[]): ShellToken[][] {
  return splitCommandSegments(tokens).map((segment) => segment.tokens);
}

function commandWords(tokens: ShellToken[]): string[] {
  return tokens
    .filter(
      (token): token is Extract<ShellToken, { kind: "word" }> =>
        token.kind === "word",
    )
    .map((token) => token.value);
}

function executableName(word: string): string {
  const windowsPath = /^(?:[A-Za-z]:\\|\\\\)/u.test(word);
  const basename = windowsPath
    ? (word.split(/[\\/]/u).at(-1) ?? "")
    : (word.split("/").at(-1) ?? "").replace(/\\(?=[A-Za-z])/gu, "");
  return basename.toLowerCase().replace(/\.(?:com|cmd|exe)$/u, "");
}

function skipOptionSequence(
  words: string[],
  start: number,
  optionsWithArguments: Set<string>,
): number {
  let index = start;
  while (index < words.length) {
    const lower = words[index].toLowerCase();
    if (lower === "--") return index + 1;
    if (!lower.startsWith("-")) break;
    const option = lower.split("=", 1)[0];
    index += 1;
    if (!lower.includes("=") && optionsWithArguments.has(option)) index += 1;
  }
  return index;
}

function unwrapCommand(
  words: string[],
): { name: string; args: string[] } | null {
  let index = 0;
  while (index < words.length && ASSIGNMENT_PATTERN.test(words[index]))
    index += 1;

  for (let wrappers = 0; wrappers < 12 && index < words.length; wrappers += 1) {
    const name = executableName(words[index]);
    if (name === "sudo") {
      index = skipOptionSequence(
        words,
        index + 1,
        new Set([
          "-c",
          "--close-from",
          "-d",
          "--chdir",
          "-g",
          "--group",
          "-h",
          "--host",
          "-p",
          "--prompt",
          "-r",
          "--role",
          "-t",
          "--type",
          "-u",
          "--user",
        ]),
      );
      continue;
    }
    if (name === "env") {
      index = skipOptionSequence(
        words,
        index + 1,
        new Set(["-c", "--chdir", "-u", "--unset"]),
      );
      while (index < words.length && ASSIGNMENT_PATTERN.test(words[index]))
        index += 1;
      continue;
    }
    if (["command", "exec", "nohup", "setsid"].includes(name)) {
      index = skipOptionSequence(words, index + 1, new Set());
      continue;
    }
    if (name === "time") {
      index = skipOptionSequence(
        words,
        index + 1,
        new Set(["-f", "--format", "-o", "--output"]),
      );
      continue;
    }
    if (name === "nice") {
      index = skipOptionSequence(
        words,
        index + 1,
        new Set(["-n", "--adjustment"]),
      );
      continue;
    }
    return { name, args: words.slice(index + 1) };
  }
  return null;
}

function trimWholeContentsSuffix(value: string): string {
  let result = value.replace(/\/\{\*,\.\*\}\/?$/u, "");
  while (/\/(?:\*|\.\*|\*\.\*)\/?$/u.test(result)) {
    result = result.replace(/\/(?:\*|\.\*|\*\.\*)\/?$/u, "");
  }
  return result;
}

function normalizeDrivePath(value: string): string | null {
  const match = /^([A-Za-z]):(?:\/(.*))?$/u.exec(value);
  if (!match) return null;
  // Bare C: means the drive's current directory, not its root.
  if (!value.includes("/")) return `${match[1].toLowerCase()}:`;
  const normalizedSuffix = path.posix.normalize(`/${match[2] ?? ""}`);
  return `${match[1].toLowerCase()}:${normalizedSuffix}`.toLowerCase();
}

function createAnalysisState(cwd?: string): AnalysisState {
  const rawCwd = cwd?.trim() || process.cwd();
  const effectiveCwd =
    rawCwd.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(rawCwd)
      ? rawCwd
      : path.resolve(rawCwd);
  const home = os.homedir();
  const variables = new Map<string, string>();
  const setDefault = (name: string, value: string | undefined): void => {
    if (!value) return;
    variables.set(name, value);
    variables.set(name.toLowerCase(), value);
  };
  setDefault("HOME", home);
  setDefault("USERPROFILE", process.env.USERPROFILE || home);
  setDefault("SystemRoot", process.env.SystemRoot || "C:\\Windows");
  setDefault("SystemDrive", process.env.SystemDrive || "C:");
  setDefault("PWD", effectiveCwd);
  return { cwd: effectiveCwd, variables };
}

function setStaticVariable(
  state: AnalysisState,
  name: string,
  value: string,
): void {
  state.variables.set(name, value);
  state.variables.set(name.toLowerCase(), value);
}

function staticVariable(
  state: AnalysisState,
  name: string,
): string | undefined {
  return state.variables.get(name) ?? state.variables.get(name.toLowerCase());
}

function resolveStaticWord(
  word: string,
  state: AnalysisState,
  expressions = new Map<string, string>(),
  depth = 0,
): string {
  let value = word;
  if (depth <= MAX_NESTED_COMMAND_DEPTH) {
    for (const [placeholder, expression] of expressions) {
      if (!value.includes(placeholder)) continue;
      const resolved = evaluateStaticExpression(expression, state, depth + 1);
      if (resolved !== null) {
        value = value
          .split(`${placeholder}.Path`)
          .join(resolved)
          .split(placeholder)
          .join(resolved);
      }
    }
  }

  value = value.replace(
    /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-+?=][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/giu,
    (match, envName, bracedName, shellName, percentName) =>
      staticVariable(
        state,
        String(envName ?? bracedName ?? shellName ?? percentName),
      ) ?? match,
  );
  if (/^~(?:\/|$)/u.test(value)) {
    value = `${staticVariable(state, "HOME") ?? os.homedir()}${value.slice(1)}`;
  }
  return value;
}

function normalizeCandidatePath(
  word: string,
  state?: AnalysisState,
  expressions?: Map<string, string>,
): string {
  let value = resolveStaticWord(
    word,
    state ?? createAnalysisState(),
    expressions,
  )
    .trim()
    .replace(/\\/gu, "/");
  value = value.replace(/^\/\/[?.]\/(?=[A-Za-z]:\/)/u, "");

  const homePrefix =
    /^(?:~(?:[^/]*)?|\$\{(?:HOME|USERPROFILE)(?::[-+?=][^}]*)?\}|\$(?:HOME|USERPROFILE)|%USERPROFILE%|\$env:USERPROFILE)(?=\/|$)/iu;
  if (homePrefix.test(value)) {
    value = value.replace(homePrefix, "/Users/__stella_home__");
  }
  value = value
    .replace(/^(?:%SystemRoot%|\$env:SystemRoot)(?=\/|$)/iu, "c:/Windows")
    .replace(/^(?:%SystemDrive%|\$env:SystemDrive)(?=\/|$)/iu, "c:");

  value = trimWholeContentsSuffix(value);
  const drivePath = normalizeDrivePath(value);
  if (drivePath) return drivePath;
  if (value.startsWith("/")) {
    const normalized = path.posix.normalize(value).toLowerCase();
    return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
  }
  if (state) {
    const normalizedCwd = normalizeCandidatePath(state.cwd);
    const cwdDrive = normalizeDrivePath(normalizedCwd);
    if (cwdDrive) {
      return normalizeDrivePath(`${cwdDrive}/${value}`) ?? value.toLowerCase();
    }
    if (normalizedCwd.startsWith("/")) {
      const normalized = path.posix
        .normalize(`${normalizedCwd}/${value}`)
        .toLowerCase();
      return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
    }
  }
  return value.toLowerCase();
}

function classifyCriticalPath(
  word: string,
  state?: AnalysisState,
  expressions?: Map<string, string>,
): CriticalPathKind | null {
  const normalized = normalizeCandidatePath(word, state, expressions);
  if (
    RAW_UNIX_DEVICE_PATTERN.test(normalized) ||
    /^\/\/[.?]\/physicaldrive\d+$/iu.test(word.replace(/\\/gu, "/")) ||
    /^\/\/[.?]\/globalroot\/device\/harddisk/iu.test(word.replace(/\\/gu, "/"))
  ) {
    return "raw-device";
  }

  if (normalized === "/" || /^[a-z]:\/$/u.test(normalized)) return "root";
  if (UNIX_SYSTEM_ROOTS.has(normalized)) return "system";
  if (
    normalized === "/system/volumes/data" ||
    /^\/volumes\/[^/]+$/u.test(normalized) ||
    /^\/mnt\/[^/]+$/u.test(normalized)
  ) {
    return "volume";
  }
  if (
    /^\/users\/[^/]+$/u.test(normalized) ||
    /^\/home\/[^/]+$/u.test(normalized)
  ) {
    return "home";
  }

  const driveMatch = /^([a-z]:)(\/.*)$/u.exec(normalized);
  if (driveMatch && WINDOWS_SYSTEM_ROOT_SUFFIXES.has(driveMatch[2]))
    return "system";
  if (/^[a-z]:\/users\/[^/]+$/u.test(normalized)) return "home";

  const actualHome = normalizeCandidatePath(os.homedir());
  if (normalized === actualHome) return "home";
  return null;
}

function deletionReason(kind: CriticalPathKind, viaFind = false): string {
  if (kind === "root") return "recursive delete of root filesystem";
  if (kind === "home") {
    return viaFind
      ? "recursive delete of a home directory via find"
      : "recursive delete of home directory";
  }
  if (kind === "volume") return "recursive delete of mounted volume root";
  if (kind === "raw-device") return "destructive write to raw device";
  return "recursive delete of a system or all-users directory";
}

function isRecursiveOption(word: string): boolean {
  const lower = word.toLowerCase();
  return lower === "--recursive" || /^-[^-]*r/u.test(lower);
}

function firstCriticalPath(
  words: string[],
  state?: AnalysisState,
  expressions?: Map<string, string>,
): CriticalPathKind | null {
  for (const word of words) {
    if (word === "--" || word.startsWith("-")) continue;
    const kind = classifyCriticalPath(word, state, expressions);
    if (kind) return kind;
  }
  return null;
}

function inspectDeleteCommand(
  name: string,
  args: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
): string | null {
  if (name === "rm" && args.some(isRecursiveOption)) {
    const kind = firstCriticalPath(args, state, expressions);
    if (kind) return deletionReason(kind);
  }

  if (["remove-item", "ri"].includes(name)) {
    const recursive = args.some((arg) => /^-recurse(?::\$?true)?$/iu.test(arg));
    if (recursive) {
      const kind = firstCriticalPath(args, state, expressions);
      if (kind) return deletionReason(kind);
    }
  }

  if (["del", "erase", "rd", "rmdir"].includes(name)) {
    const recursive = args.some(
      (arg) =>
        /^\/(?:s|S)$/u.test(arg) || /^-recurse(?::\$?true)?$/iu.test(arg),
    );
    if (recursive) {
      const kind = firstCriticalPath(args, state, expressions);
      if (kind) return deletionReason(kind);
    }
  }
  return null;
}

function inspectFind(
  args: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
  depth: number,
): string | null {
  let index = 0;
  if (args[index] === "--") index += 1;
  const targets: string[] = [];
  while (index < args.length) {
    const word = args[index];
    if (word === "!" || word === "(" || word.startsWith("-")) break;
    targets.push(word);
    index += 1;
  }
  const kind = firstCriticalPath(targets, state, expressions);
  if (!kind) return null;

  const hasDelete = args.some((arg) => arg.toLowerCase() === "-delete");
  const hasDestructiveExec = args.some((arg, argIndex) => {
    if (!["-exec", "-execdir"].includes(arg.toLowerCase())) return false;
    const terminator = args.findIndex(
      (candidate, index) =>
        index > argIndex && [";", "+", "\\;"].includes(candidate),
    );
    const execWords = args.slice(
      argIndex + 1,
      terminator >= 0 ? terminator : undefined,
    );
    const unwrapped = unwrapCommand(execWords);
    if (!unwrapped) return false;
    if (["rm", "unlink", "rmdir"].includes(unwrapped.name)) return true;
    const literal = shellLiteral(unwrapped.name, unwrapped.args);
    if (literal && commandContainsDeleteExecutable(literal, depth + 1)) {
      return true;
    }
    return inspectCommand(execWords.join(" "), depth + 1, state) !== null;
  });
  return hasDelete || hasDestructiveExec ? deletionReason(kind, true) : null;
}

function isHelpOnly(args: string[]): boolean {
  return (
    args.length > 0 &&
    args.every((arg) => /^(?:--help|--version|\/?\?)$/iu.test(arg))
  );
}

function inspectFilesystemErase(
  name: string,
  args: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
): string | null {
  if (/^(?:mkfs(?:\..+)?|mke2fs|newfs(?:_.+)?)$/u.test(name)) {
    return args.some(
      (arg) => classifyCriticalPath(arg, state, expressions) === "raw-device",
    )
      ? "format filesystem on raw device"
      : null;
  }
  if (name === "format" && args.some((arg) => /^[A-Za-z]:$/u.test(arg))) {
    return "format drive";
  }
  if (name === "diskutil") {
    const operation = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (
      [
        "erasedisk",
        "erasevolume",
        "secureerase",
        "zerodisk",
        "randomdisk",
      ].includes(operation ?? "")
    ) {
      return "erase disk or volume";
    }
  }
  if (
    name === "clear-disk" &&
    !args.some((arg) => /^-(?:whatif|confirm:\$false)$/iu.test(arg))
  ) {
    return "erase disk";
  }
  if (
    ["blkdiscard", "wipefs"].includes(name) &&
    args.some(
      (arg) => classifyCriticalPath(arg, state, expressions) === "raw-device",
    )
  ) {
    return "erase raw block device";
  }
  return null;
}

function inspectRawDeviceWrite(
  name: string,
  args: string[],
  tokens: ShellToken[],
  state: AnalysisState,
  expressions: Map<string, string>,
): string | null {
  if (name === "dd") {
    const output = args.find((arg) => /^of=/iu.test(arg));
    if (
      output &&
      classifyCriticalPath(
        output.slice(output.indexOf("=") + 1),
        state,
        expressions,
      ) === "raw-device"
    ) {
      return "dd to raw block device";
    }
  }
  if (["cp", "install", "mv", "shred", "tee"].includes(name)) {
    if (
      args.some(
        (arg) => classifyCriticalPath(arg, state, expressions) === "raw-device",
      )
    ) {
      return "destructive write to raw device";
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (
      token.kind === "operator" &&
      (token.value === ">" || token.value === ">>")
    ) {
      const target = tokens
        .slice(index + 1)
        .find((candidate) => candidate.kind === "word");
      if (
        target?.kind === "word" &&
        classifyCriticalPath(target.value, state, expressions) === "raw-device"
      ) {
        return "redirect to raw block device";
      }
    }
  }
  return null;
}

function inspectHostDisruption(name: string, args: string[]): string | null {
  if (name === "shutdown") {
    if (
      args.some((arg) => /^(?:-c|--cancel|\/a)$/iu.test(arg)) ||
      isHelpOnly(args)
    )
      return null;
    return "system shutdown/reboot";
  }
  if (["reboot", "halt", "poweroff"].includes(name)) {
    return isHelpOnly(args) ? null : "system shutdown/reboot";
  }
  if (name === "systemctl") {
    if (args.some((arg) => arg === "--dry-run")) return null;
    const operation = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (["halt", "kexec", "poweroff", "reboot"].includes(operation ?? "")) {
      return "systemctl poweroff/reboot";
    }
  }
  if (["restart-computer", "stop-computer"].includes(name)) {
    return args.some((arg) => /^-(?:whatif|confirm:\$false)$/iu.test(arg))
      ? null
      : "system shutdown/reboot";
  }
  if (name === "kill") {
    const separator = args.indexOf("--");
    if (
      (separator >= 0 && args.slice(separator + 1).includes("-1")) ||
      (args.length >= 2 && args.at(-1) === "-1")
    ) {
      return "kill all processes";
    }
  }
  if (name === "killall5") return "kill all processes";
  if (
    name === "taskkill" &&
    args.some((arg) => /^\/(?:im|fi)$/iu.test(arg)) &&
    args.includes("*")
  ) {
    return "kill all processes";
  }
  if (name === "init" || name === "telinit") {
    if (args.some((arg) => arg === "0" || arg === "6"))
      return "system shutdown/reboot";
  }
  return null;
}

function shellLiteral(name: string, args: string[]): string | null {
  if (["bash", "dash", "fish", "ksh", "sh", "zsh"].includes(name)) {
    const commandIndex = args.findIndex(
      (arg) =>
        arg === "-c" ||
        (/^-[A-Za-z]+$/u.test(arg) && arg.slice(1).includes("c")),
    );
    return commandIndex >= 0 ? (args[commandIndex + 1] ?? null) : null;
  }
  if (["powershell", "pwsh"].includes(name)) {
    const commandIndex = args.findIndex((arg) =>
      /^(?:-c|-command)$/iu.test(arg),
    );
    if (commandIndex >= 0)
      return args.slice(commandIndex + 1).join(" ") || null;
    const encodedIndex = args.findIndex((arg) =>
      /^(?:-e|-enc|-encodedcommand)$/iu.test(arg),
    );
    if (encodedIndex >= 0 && args[encodedIndex + 1]) {
      try {
        return Buffer.from(args[encodedIndex + 1], "base64").toString(
          "utf16le",
        );
      } catch {
        return null;
      }
    }
  }
  if (name === "cmd") {
    const commandIndex = args.findIndex((arg) => /^\/(?:c|k)$/iu.test(arg));
    return commandIndex >= 0
      ? args.slice(commandIndex + 1).join(" ") || null
      : null;
  }
  if (name === "eval") return args.join(" ") || null;
  return null;
}

function inspectEnvSplitString(words: string[]): string | null {
  const envIndex = words.findIndex((word) => executableName(word) === "env");
  if (envIndex < 0) return null;
  const splitIndex = words.findIndex(
    (word, index) =>
      index > envIndex && (word === "-S" || word === "--split-string"),
  );
  if (splitIndex >= 0) return words[splitIndex + 1] ?? null;
  const attached = words
    .slice(envIndex + 1)
    .find((word) => word.startsWith("--split-string=") || /^-S.+/u.test(word));
  if (!attached) return null;
  return attached.startsWith("--split-string=")
    ? attached.slice("--split-string=".length)
    : attached.slice(2);
}

function cloneAnalysisState(state: AnalysisState): AnalysisState {
  return { cwd: state.cwd, variables: new Map(state.variables) };
}

function recordSimpleAssignments(
  words: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
): void {
  const record = (name: string, value: string): void => {
    setStaticVariable(
      state,
      name.replace(/^\$env:/iu, ""),
      resolveStaticWord(value, state, expressions),
    );
  };

  for (const word of words) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word);
    if (!match) break;
    record(match[1], match[2]);
  }

  const envIndex = words.findIndex((word) => executableName(word) === "env");
  if (envIndex >= 0) {
    for (const word of words.slice(envIndex + 1)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word);
      if (match) record(match[1], match[2]);
    }
  }

  const name = executableName(words[0] ?? "");
  if (["declare", "export", "readonly", "typeset"].includes(name)) {
    for (const word of words.slice(1)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word);
      if (match) record(match[1], match[2]);
    }
  }
  if (name === "set" && words[1]) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(
      words.slice(1).join(" "),
    );
    if (match) record(match[1], match[2]);
  }
  if (
    /^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*$/iu.test(words[0] ?? "") &&
    words[1] === "="
  ) {
    record(words[0].replace(/^\$(?:env:)?/iu, ""), words.slice(2).join(" "));
  }
  if (name === "set-variable") {
    const nameIndex = words.findIndex((word) => /^-(?:name|n)$/iu.test(word));
    const valueIndex = words.findIndex((word) => /^-(?:value|v)$/iu.test(word));
    if (nameIndex >= 0 && valueIndex >= 0) {
      record(words[nameIndex + 1] ?? "", words[valueIndex + 1] ?? "");
    }
  }
}

function updateStaticCwd(
  name: string,
  args: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
): boolean {
  if (!["cd", "chdir", "pushd", "set-location", "sl"].includes(name)) {
    return false;
  }
  const target =
    args.find((arg) => arg !== "/d" && !arg.startsWith("-")) ??
    staticVariable(state, "HOME");
  if (!target) return true;
  state.cwd = normalizeCandidatePath(target, state, expressions);
  setStaticVariable(state, "PWD", state.cwd);
  return true;
}

function evaluateStaticExecutable(
  name: string,
  args: string[],
  state: AnalysisState,
  expressions: Map<string, string>,
): string | null {
  if (["pwd", "get-location"].includes(name)) return state.cwd;
  const resolvedArgs = args.map((arg) =>
    resolveStaticWord(arg, state, expressions),
  );
  if (["resolve-path", "realpath"].includes(name)) {
    const target = resolvedArgs.find((arg) => !arg.startsWith("-"));
    return target ? normalizeCandidatePath(target, state) : null;
  }
  if (name === "readlink" && resolvedArgs.includes("-f")) {
    const target = resolvedArgs.find((arg) => !arg.startsWith("-"));
    return target ? normalizeCandidatePath(target, state) : null;
  }
  if (name === "dirname") {
    const target = resolvedArgs.find((arg) => !arg.startsWith("-"));
    if (!target) return null;
    const normalized = normalizeCandidatePath(target, state);
    const drive = /^([a-z]:)(\/.*)$/u.exec(normalized);
    return drive
      ? `${drive[1]}${path.posix.dirname(drive[2])}`
      : path.posix.dirname(normalized);
  }
  if (name === "echo") {
    return resolvedArgs.filter((arg) => arg !== "-n").join(" ");
  }
  if (name === "printf") {
    const values = resolvedArgs.filter((arg) => !arg.startsWith("--"));
    const format = values[0];
    if (!format) return null;
    if (!format.includes("%")) return format.replace(/\\n$/u, "");
    if (/^%s(?:\\n)?$/u.test(format) && values[1]) return values[1];
  }
  return null;
}

function evaluateStaticExpression(
  expression: string,
  state: AnalysisState,
  depth: number,
): string | null {
  if (depth > MAX_NESTED_COMMAND_DEPTH) return null;
  const expressionState = cloneAnalysisState(state);
  const lexed = lexShell(expression);
  let output: string | null = null;
  for (const tokens of splitCommands(lexed.tokens)) {
    const words = commandWords(tokens);
    if (words.length === 0) continue;
    recordSimpleAssignments(words, expressionState, lexed.staticExpressions);
    const commandInfo = unwrapCommand(words);
    if (!commandInfo) continue;
    if (
      updateStaticCwd(
        commandInfo.name,
        commandInfo.args,
        expressionState,
        lexed.staticExpressions,
      )
    ) {
      output = null;
      continue;
    }
    output = evaluateStaticExecutable(
      commandInfo.name,
      commandInfo.args,
      expressionState,
      lexed.staticExpressions,
    );
  }
  return output;
}

function commandContainsDeleteExecutable(
  command: string,
  depth: number,
): boolean {
  if (depth > MAX_NESTED_COMMAND_DEPTH) return false;
  const lexed = lexShell(command);
  for (const tokens of splitCommands(lexed.tokens)) {
    const commandInfo = unwrapCommand(commandWords(tokens));
    if (!commandInfo) continue;
    if (["rm", "unlink", "rmdir", "remove-item"].includes(commandInfo.name)) {
      return true;
    }
    const literal = shellLiteral(commandInfo.name, commandInfo.args);
    if (literal && commandContainsDeleteExecutable(literal, depth + 1))
      return true;
  }
  return false;
}

function inspectXargs(
  args: string[],
  state: AnalysisState,
  depth: number,
  pipedValue?: string | null,
): string | null {
  let index = 0;
  const optionsWithArguments = new Set([
    "-a",
    "--arg-file",
    "-e",
    "--eof",
    "-i",
    "--replace",
    "-l",
    "--max-lines",
    "-n",
    "--max-args",
    "-p",
    "--max-procs",
    "-s",
    "--max-chars",
  ]);
  index = skipOptionSequence(args, index, optionsWithArguments);
  const nested = args.slice(index);
  if (pipedValue !== undefined && pipedValue !== null) nested.push(pipedValue);
  return nested.length > 0
    ? inspectCommand(nested.join(" "), depth + 1, cloneAnalysisState(state))
    : null;
}

function inspectStaticPipelines(
  lexed: LexedShell,
  state: AnalysisState,
  depth: number,
): string | null {
  let priorOutput: string | null = null;
  for (const segment of splitCommandSegments(lexed.tokens)) {
    const words = commandWords(segment.tokens);
    if (words.length === 0) continue;
    recordSimpleAssignments(words, state, lexed.staticExpressions);
    const commandInfo = unwrapCommand(words);
    if (!commandInfo) {
      priorOutput = null;
      continue;
    }
    if (commandInfo.name === "xargs" && segment.precedingOperator === "|") {
      const reason = inspectXargs(commandInfo.args, state, depth, priorOutput);
      if (reason) return reason;
    }
    if (
      ["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"].includes(
        commandInfo.name,
      ) &&
      segment.precedingOperator === "|" &&
      priorOutput
    ) {
      const reason = inspectDeleteCommand(
        commandInfo.name,
        [...commandInfo.args, priorOutput],
        state,
        lexed.staticExpressions,
      );
      if (reason) return reason;
    }
    if (
      updateStaticCwd(
        commandInfo.name,
        commandInfo.args,
        state,
        lexed.staticExpressions,
      )
    ) {
      priorOutput = null;
      continue;
    }
    priorOutput = evaluateStaticExecutable(
      commandInfo.name,
      commandInfo.args,
      state,
      lexed.staticExpressions,
    );
  }
  return null;
}

function inspectCommand(
  command: string,
  depth: number,
  suppliedState?: AnalysisState,
): string | null {
  if (depth > MAX_NESTED_COMMAND_DEPTH) return null;
  // This exact token sequence is shell grammar rather than a normal command.
  if (/^\s*:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\s*$/u.test(command)) {
    return "fork bomb";
  }

  const lexed = lexShell(command);
  const state = suppliedState ?? createAnalysisState();
  const pipelineReason = inspectStaticPipelines(
    lexed,
    cloneAnalysisState(state),
    depth,
  );
  if (pipelineReason) return pipelineReason;
  for (const nested of lexed.nestedCommands) {
    const reason = inspectCommand(nested, depth + 1, cloneAnalysisState(state));
    if (reason) return reason;
  }

  for (const tokens of splitCommands(lexed.tokens)) {
    const words = commandWords(tokens);
    if (words.length === 0) continue;
    recordSimpleAssignments(words, state, lexed.staticExpressions);

    const splitString = inspectEnvSplitString(words);
    if (splitString) {
      const reason = inspectCommand(
        splitString,
        depth + 1,
        cloneAnalysisState(state),
      );
      if (reason) return reason;
    }

    const commandInfo = unwrapCommand(words);
    if (!commandInfo) continue;
    const { name, args } = commandInfo;

    if (updateStaticCwd(name, args, state, lexed.staticExpressions)) continue;

    const literal = shellLiteral(name, args);
    if (literal) {
      const reason = inspectCommand(
        literal,
        depth + 1,
        cloneAnalysisState(state),
      );
      if (reason) return reason;
    }

    const reason =
      inspectDeleteCommand(name, args, state, lexed.staticExpressions) ??
      (name === "find"
        ? inspectFind(args, state, lexed.staticExpressions, depth)
        : null) ??
      (name === "xargs" ? inspectXargs(args, state, depth) : null) ??
      inspectFilesystemErase(name, args, state, lexed.staticExpressions) ??
      inspectRawDeviceWrite(
        name,
        args,
        tokens,
        state,
        lexed.staticExpressions,
      ) ??
      inspectHostDisruption(name, args);
    if (reason) return reason;
  }
  return null;
}

/**
 * Returns a reason only for catastrophic, host-wide shell operations. This is
 * a final footgun guard, not a sandbox, approval policy, or general-purpose
 * destructive-command filter.
 */
export function getCatastrophicShellCommandReason(
  command: string,
  cwd?: string,
): string | null {
  return inspectCommand(command, 0, createAnalysisState(cwd));
}
