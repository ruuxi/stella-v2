import CryptoKit
import Foundation

struct LauncherError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Everything the launcher owns lives under one root:
/// `app/` (the checkout), `runtimes/{bun-<v>,git-<v>}`,
/// `bundles/electron-<v>/Stella.app`, `signing.pub`, `launcher-state.json`
/// and `logs/launcher.log`.
struct LauncherPaths {
    let root: URL
    /// Set by `STELLA_LAUNCHER_ROOT` (testing). An overridden root also gets
    /// its own Electron userData and Stella home, so a test install never
    /// touches the real profile or collides with a running Stella.
    let isolated: Bool

    static func resolve() -> LauncherPaths {
        let raw = ProcessInfo.processInfo.environment["STELLA_LAUNCHER_ROOT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !raw.isEmpty {
            let expanded = (raw as NSString).expandingTildeInPath
            return LauncherPaths(root: URL(fileURLWithPath: expanded).standardizedFileURL, isolated: true)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return LauncherPaths(root: support.appendingPathComponent("Stella"), isolated: false)
    }

    var app: URL { root.appendingPathComponent("app") }
    var runtimes: URL { root.appendingPathComponent("runtimes") }
    var bundles: URL { root.appendingPathComponent("bundles") }
    var logs: URL { root.appendingPathComponent("logs") }
    var launcherLog: URL { logs.appendingPathComponent("launcher.log") }
    var electronLog: URL { logs.appendingPathComponent("electron.log") }
    var installLog: URL { logs.appendingPathComponent("install.log") }
    var signingPub: URL { root.appendingPathComponent("signing.pub") }
    var stateFile: URL { root.appendingPathComponent("launcher-state.json") }
    var lockFile: URL { root.appendingPathComponent("launcher.lock") }
    var isolatedUserData: URL { root.appendingPathComponent("user-data") }
    var isolatedHome: URL { root.appendingPathComponent("stella-home") }
}

/// Versions baked into this launcher build. A signed tree may ask for a newer
/// Bun through `packages/desktop/launcher.json`.
enum Pins {
    struct Asset {
        let url: String
        let sha256: String
        /// Path of the executable inside the archive, for zips.
        let member: String?
    }

    static var platformKey: String {
        #if arch(arm64)
        return "darwin-arm64"
        #else
        return "darwin-x64"
        #endif
    }

    static let bunVersion = "1.4.0"
    static let bun: [String: Asset] = [
        "darwin-arm64": Asset(
            url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip",
            sha256: "c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381",
            member: "bun-darwin-aarch64/bun"),
        "darwin-x64": Asset(
            url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-x64.zip",
            sha256: "1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0",
            member: "bun-darwin-x64/bun"),
    ]

    // From the managed git-runtime manifest on R2
    // (git-runtime/versions/2.53.0/manifest.json), pinned so a tampered
    // manifest can't swap the binary.
    static let gitVersion = "2.53.0"
    static let git: [String: Asset] = [
        "darwin-arm64": Asset(
            url: "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/objects/40b8edd68fa4f93cd150009a4de58aa94a41c714f848404d6de1b9ee6d3e8107.tar.gz",
            sha256: "40b8edd68fa4f93cd150009a4de58aa94a41c714f848404d6de1b9ee6d3e8107",
            member: nil),
        "darwin-x64": Asset(
            url: "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/objects/62b488592a272a3e5b4435351b085839227b6c6b781d7a883dfa89427a6ffd66.tar.gz",
            sha256: "62b488592a272a3e5b4435351b085839227b6c6b781d7a883dfa89427a6ffd66",
            member: nil),
    ]

    static let defaultBackendURL = "https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev"
    static let upstreamBranch = "main"
    static let upstreamRemoteName = "stella-upstream"
}

final class Logger {
    static var shared: Logger?
    private let lock = NSLock()
    private let handle: FileHandle?
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    func write(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        let data = Data(line.utf8)
        lock.lock()
        defer { lock.unlock() }
        try? handle?.write(contentsOf: data)
        FileHandle.standardError.write(data)
    }
}

func log(_ message: String) {
    Logger.shared?.write(message)
}

struct ShellResult {
    let code: Int32
    let stdout: String
    let stderr: String
}

enum Shell {
    /// Run a program without a shell. With `outputFile`, stdout and stderr are
    /// appended to that file (long installs whose grandchildren might hold a
    /// pipe open); `stderr` then holds the file's tail.
    static func run(
        _ executable: String,
        _ args: [String],
        cwd: URL? = nil,
        env: [String: String],
        outputFile: URL? = nil,
        timeout: TimeInterval? = nil
    ) throws -> ShellResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        if let cwd { process.currentDirectoryURL = cwd }
        process.environment = env
        process.standardInput = FileHandle.nullDevice

        if let outputFile {
            if !FileManager.default.fileExists(atPath: outputFile.path) {
                FileManager.default.createFile(atPath: outputFile.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: outputFile)
            _ = try? handle.seekToEnd()
            let header = "\n$ \(executable) \(args.joined(separator: " "))\n"
            try? handle.write(contentsOf: Data(header.utf8))
            process.standardOutput = handle
            process.standardError = handle
            try process.run()
            let timedOut = killAfter(timeout, process)
            process.waitUntilExit()
            try? handle.close()
            if timedOut.value {
                throw LauncherError("\(URL(fileURLWithPath: executable).lastPathComponent) \(args.first ?? "") timed out after \(Int(timeout ?? 0))s.")
            }
            return ShellResult(code: process.terminationStatus, stdout: "", stderr: tail(of: outputFile, bytes: 4000))
        }

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        try process.run()
        let timedOut = killAfter(timeout, process)
        group.enter()
        DispatchQueue.global().async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        process.waitUntilExit()
        group.wait()
        if timedOut.value {
            throw LauncherError("\(URL(fileURLWithPath: executable).lastPathComponent) \(args.first ?? "") timed out after \(Int(timeout ?? 0))s.")
        }
        return ShellResult(
            code: process.terminationStatus,
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self))
    }

    final class Flag { var value = false }

    /// Kill the process and everything it started once `timeout` passes.
    private static func killAfter(_ timeout: TimeInterval?, _ process: Process) -> Flag {
        let flag = Flag()
        guard let timeout else { return flag }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard process.isRunning else { return }
            flag.value = true
            log("shell: \(process.executableURL?.lastPathComponent ?? "?") exceeded \(Int(timeout))s; killing its process tree")
            killTree(process.processIdentifier)
        }
        return flag
    }

    static func killTree(_ pid: pid_t) {
        if let children = try? run("/usr/bin/pgrep", ["-P", String(pid)], env: [:]) {
            for line in children.stdout.split(separator: "\n") {
                if let child = pid_t(line.trimmingCharacters(in: .whitespaces)) { killTree(child) }
            }
        }
        kill(pid, SIGKILL)
    }

    static func tail(of url: URL, bytes: Int) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(bytes) ? size - UInt64(bytes) : 0
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

enum Net {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 30 * 60
        return URLSession(configuration: config)
    }()

    static func fetch(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, HTTPURLResponse), Error> = .failure(LauncherError("No response."))
        session.dataTask(with: request) { data, response, error in
            if let error {
                result = .failure(error)
            } else if let http = response as? HTTPURLResponse {
                result = .success((data ?? Data(), http))
            }
            semaphore.signal()
        }.resume()
        semaphore.wait()
        return try result.get()
    }

    /// Download to `destination`, refusing anything whose sha256 differs.
    static func download(_ url: URL, to destination: URL, sha256 expected: String) throws {
        let semaphore = DispatchSemaphore(value: 0)
        let staging = destination.appendingPathExtension("download")
        try? FileManager.default.removeItem(at: staging)
        var failure: Error?
        session.downloadTask(with: url) { location, response, error in
            defer { semaphore.signal() }
            if let error { failure = error; return }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let location else {
                failure = LauncherError("Download of \(url.absoluteString) failed (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)).")
                return
            }
            do { try FileManager.default.moveItem(at: location, to: staging) } catch { failure = error }
        }.resume()
        semaphore.wait()
        if let failure { throw failure }
        let actual = try sha256File(staging)
        guard actual == expected.lowercased() else {
            try? FileManager.default.removeItem(at: staging)
            throw LauncherError("Checksum mismatch for \(url.lastPathComponent): expected \(expected), got \(actual).")
        }
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: staging, to: destination)
    }
}

func sha256File(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

struct LauncherState: Codable {
    /// sha256 of `app/bun.lock` at the last successful `bun install`.
    var bunLockHash: String?
    /// HEAD at the last successful `prepare-install.mjs`.
    var preparedHead: String?
    var installedAt: String?

    static func load(_ paths: LauncherPaths) -> LauncherState {
        guard let data = try? Data(contentsOf: paths.stateFile),
              let state = try? JSONDecoder().decode(LauncherState.self, from: data)
        else { return LauncherState() }
        return state
    }

    func save(_ paths: LauncherPaths) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(self) else { return }
        try? data.write(to: paths.stateFile, options: .atomic)
    }
}
