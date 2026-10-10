/**
 * A pi-durable ExecutionEnv over a narrow remote shell: run a command, read
 * a file, write a file. That is all a Stella cloud container exposes (the
 * Sandbox object's exec/readFile/writeFile), so every other file operation
 * is a small POSIX command. pi-durable's tools (read, write, edit, bash) then
 * work unchanged inside the container.
 *
 * Output arrives when a command ends, not as it runs: the backend has no
 * streaming exec. Files are read whole, which bounds this to ordinary source
 * and document sizes (`MAX_FILE_BYTES`).
 */
import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { posix } from "node:path";

/** What a remote shell host must provide. */
export type ShellBackend = {
  /** The file namespace: equal ids see the same files at the same paths. */
  readonly id: string;
  readonly cwd: string;
  exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /** The file's bytes, or undefined when it does not exist. */
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
  writeFile(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
};

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One argument, single-quoted for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const codeFor = (stderr: string): FileErrorCode => {
  if (/No such file|not found|does not exist/i.test(stderr)) return "not_found";
  if (/Permission denied|Operation not permitted/i.test(stderr)) return "permission_denied";
  if (/Not a directory/i.test(stderr)) return "not_directory";
  if (/Is a directory/i.test(stderr)) return "is_directory";
  return "unknown";
};

const failure = (error: unknown, path?: string): FileError =>
  error instanceof FileError
    ? error
    : new FileError(
        error instanceof Error && error.name === "AbortError" ? "aborted" : "unknown",
        error instanceof Error ? error.message : String(error),
        path,
        error instanceof Error ? error : undefined,
      );

const kindOf = (letter: string): FileKind | undefined =>
  letter === "f" ? "file" : letter === "d" ? "directory" : letter === "l" ? "symlink" : undefined;

const bytesOf = (content: string | Uint8Array): Uint8Array => (typeof content === "string" ? encoder.encode(content) : content);

export class ShellExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #backend: ShellBackend;

  constructor(backend: ShellBackend) {
    this.#backend = backend;
    this.id = backend.id;
    this.cwd = backend.cwd;
  }

  #resolve(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  /** Run a file command; a nonzero exit becomes a FileError. */
  async #run(script: string, path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      const result = await this.#backend.exec(script, { cwd: this.cwd, signal: context.abortSignal });
      if (result.exitCode !== 0) return err(new FileError(codeFor(result.stderr), result.stderr.trim() || `exit ${result.exitCode}`, path));
      return ok(result.stdout);
    } catch (error) {
      return err(failure(error, path));
    }
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.#resolve(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const absolute = this.#resolve(path);
    const info = await this.fileInfo(absolute, context);
    if (!info.ok) return info;
    if (info.value.kind === "directory") return err(new FileError("is_directory", `${absolute} is a directory`, absolute));
    if (info.value.size > MAX_FILE_BYTES) {
      return err(new FileError("invalid", `${absolute} is larger than ${MAX_FILE_BYTES} bytes`, absolute));
    }
    try {
      const bytes = await this.#backend.readFile(absolute, context.abortSignal);
      return bytes === undefined ? err(new FileError("not_found", `${absolute} does not exist`, absolute)) : ok(bytes);
    } catch (error) {
      return err(failure(error, absolute));
    }
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(decoder.decode(bytes.value)) : bytes;
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const parts = text.value.split("\n");
    let index = 0;
    return ok({
      readLine: async () => {
        if (index >= parts.length || (index === parts.length - 1 && parts[index] === "")) return ok(undefined);
        const line = { text: parts[index]!, terminated: index < parts.length - 1 };
        index += 1;
        return ok(line);
      },
      close: async () => {},
    });
  }

  async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const absolute = this.#resolve(path);
    const info = await this.fileInfo(absolute, context);
    if (!info.ok) return info;
    const bytes = await this.readBinaryFile(absolute, context);
    if (!bytes.ok) return bytes;
    const data = bytes.value;
    const opened: FileInfo = { ...info.value, size: data.byteLength };
    return ok({
      info: async () => ok(opened),
      read: async (offset, length) => ok(data.slice(offset, Math.min(data.byteLength, offset + length))),
      scanLines: async ({ startLine, endLine }) => {
        const scanner = new LineScanner(startLine, endLine);
        scanner.push(data);
        return ok(scanner.finish());
      },
      close: async () => {},
    });
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const parent = await this.#run(`mkdir -p -- ${shellQuote(posix.dirname(absolute))}`, absolute, context);
    if (!parent.ok) return parent;
    try {
      await this.#backend.writeFile(absolute, bytesOf(content), context.abortSignal);
      return ok(undefined);
    } catch (error) {
      return err(failure(error, absolute));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const existing = await this.readBinaryFile(absolute, context);
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const before = existing.ok ? existing.value : new Uint8Array();
    const added = bytesOf(content);
    const joined = new Uint8Array(before.byteLength + added.byteLength);
    joined.set(before);
    joined.set(added, before.byteLength);
    return this.writeFile(absolute, joined, context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const result = await this.#run(`truncate -s ${Math.max(0, Math.floor(size))} -- ${shellQuote(absolute)}`, absolute, context);
    return result.ok ? ok(undefined) : result;
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const result = await this.#run(`sync -- ${shellQuote(absolute)} 2>/dev/null || true`, absolute, context);
    return result.ok ? ok(undefined) : result;
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const from = this.#resolve(sourcePath);
    const to = this.#resolve(destinationPath);
    const result = await this.#run(`mv -f -- ${shellQuote(from)} ${shellQuote(to)}`, from, context);
    return result.ok ? ok(undefined) : result;
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const absolute = this.#resolve(path);
    // %y: f, d, l; size in bytes; mtime in seconds with fraction.
    const result = await this.#run(
      `if [ -e ${shellQuote(absolute)} ] || [ -L ${shellQuote(absolute)} ]; then find ${shellQuote(absolute)} -maxdepth 0 -printf '%y\\t%s\\t%T@\\n'; else echo 'No such file' >&2; exit 2; fi`,
      absolute,
      context,
    );
    if (!result.ok) return result;
    const [letter = "", size = "0", mtime = "0"] = result.value.trim().split("\t");
    const kind = kindOf(letter);
    if (!kind) return err(new FileError("not_supported", `${absolute} is not a file, directory or link`, absolute));
    return ok({ name: posix.basename(absolute), path: absolute, kind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) });
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const absolute = this.#resolve(path);
    const result = await this.#run(
      `cd -- ${shellQuote(absolute)} && find . -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n'`,
      absolute,
      context,
    );
    if (!result.ok) return result;
    const entries: FileInfo[] = [];
    for (const line of result.value.split("\n")) {
      if (!line) continue;
      const [name = "", letter = "", size = "0", mtime = "0"] = line.split("\t");
      const kind = kindOf(letter);
      if (!kind) continue;
      entries.push({ name, path: posix.join(absolute, name), kind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) });
    }
    return ok(entries);
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const listed = await this.listDir(path, context);
    if (!listed.ok) return listed;
    let index = 0;
    return ok({
      next: async (maxEntries) => {
        const entries = listed.value.slice(index, index + maxEntries);
        index += entries.length;
        return ok({ entries, done: index >= listed.value.length });
      },
      close: async () => {},
    });
  }

  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "This environment does not watch files."));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const absolute = this.#resolve(path);
    const result = await this.#run(`realpath -e -- ${shellQuote(absolute)}`, absolute, context);
    return result.ok ? ok(result.value.trim()) : result;
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const absolute = this.#resolve(path);
    try {
      const result = await this.#backend.exec(`test -e ${shellQuote(absolute)} || test -L ${shellQuote(absolute)}`, {
        cwd: this.cwd,
        signal: context.abortSignal,
      });
      return ok(result.exitCode === 0);
    } catch (error) {
      return err(failure(error, absolute));
    }
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const result = await this.#run(`mkdir ${options?.recursive ? "-p " : ""}-- ${shellQuote(absolute)}`, absolute, context);
    return result.ok ? ok(undefined) : result;
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const absolute = this.#resolve(path);
    const flags = `${options?.recursive ? "-r " : ""}${options?.force ? "-f " : ""}`;
    const result = await this.#run(`rm ${flags}-- ${shellQuote(absolute)}`, absolute, context);
    return result.ok ? ok(undefined) : result;
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const result = await this.#run(`mktemp -d -t ${shellQuote(`${prefix ?? "stella-"}XXXXXX`)}`, "/tmp", context);
    return result.ok ? ok(result.value.trim()) : result;
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const suffix = options?.suffix ? ` --suffix=${shellQuote(options.suffix)}` : "";
    const result = await this.#run(`mktemp -t ${shellQuote(`${options?.prefix ?? "stella-"}XXXXXX`)}${suffix}`, "/tmp", context);
    return result.ok ? ok(result.value.trim()) : result;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const script = typeof command === "string" ? command : command.map(shellQuote).join(" ");
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "The command was aborted before it started."));
    let result: Awaited<ReturnType<ShellBackend["exec"]>>;
    try {
      result = await this.#backend.exec(script, {
        cwd: options?.cwd ? this.#resolve(options.cwd) : this.cwd,
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.timeout !== undefined ? { timeoutMs: Math.ceil(options.timeout * 1000) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) return err(new ExecutionError("aborted", "The command was aborted."));
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)));
    }
    try {
      if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: "stdout" });
      if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: "stderr" });
    } catch (error) {
      return err(new ExecutionError("callback_error", error instanceof Error ? error.message : String(error)));
    }
    if (result.timedOut) return err(new ExecutionError("timeout", `The command timed out after ${options?.timeout ?? "?"} seconds.`));
    return ok({ exitCode: result.exitCode });
  }

  async cleanup(): Promise<void> {}
}
