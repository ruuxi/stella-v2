import Darwin
import Foundation

struct Options {
    var selfTest = false
    /// A local path or git URL to clone instead of the upstream bootstrap.
    var source: String?
    var sourceRef: String?
    var backend = ProcessInfo.processInfo.environment["STELLA_LAUNCHER_BACKEND_URL"] ?? Pins.defaultBackendURL
    /// Self-test: stay up this long after `ready` before asking Electron to quit.
    var hold: TimeInterval = 0
    /// Self-test: the recovery button to click on the first failure.
    var recoveryChoice: RecoveryChoice?
    /// Save PNGs of the launcher's own windows here.
    var captureDir: URL?
    /// Adopt this Bun binary instead of downloading (offline testing).
    var localBun: String?
    var readyTimeout: TimeInterval = Options.seconds("STELLA_LAUNCHER_READY_TIMEOUT_SECONDS", 90)
    var stableSeconds: TimeInterval = Options.seconds("STELLA_LAUNCHER_STABLE_SECONDS", 60)

    static func seconds(_ name: String, _ fallback: TimeInterval) -> TimeInterval {
        guard let raw = ProcessInfo.processInfo.environment[name], let value = TimeInterval(raw), value > 0 else {
            return fallback
        }
        return value
    }
}

/// Install → verify → prepare → spawn → supervise, looping on relaunch
/// requests, crashes and recovery choices.
final class Launcher {
    static let relaunchExitCode: Int32 = 75
    static let knownGoodRef = "refs/stella/known-good"

    private let options: Options
    private let paths: LauncherPaths
    private let progress: ProgressWindow
    private var state: LauncherState
    private var git: GitTool?
    private var signer: TreeSigner?
    private var runtimes: Runtimes?
    private var recoveryCount = 0
    private var crashTimes: [Date] = []
    private(set) var current: ElectronProcess?

    init(options: Options, paths: LauncherPaths) {
        self.options = options
        self.paths = paths
        progress = ProgressWindow(captureDir: options.captureDir)
        state = LauncherState.load(paths)
    }

    // MARK: Main loop

    func run() -> Int32 {
        log("launcher: start root=\(paths.root.path) selfTest=\(options.selfTest) pid=\(getpid())")
        while true {
            var failure: (reason: String, output: [String])?
            do {
                let electronApp = try prepareForLaunch()
                progress.hide()
                switch supervise(electronApp: electronApp) {
                case .quit:
                    log("launcher: Stella quit; exiting")
                    return 0
                case .relaunch:
                    log("launcher: relaunch requested")
                    continue
                case let .crashed(sinceReady, detail, output):
                    let now = Date()
                    if sinceReady < options.stableSeconds {
                        crashTimes = crashTimes.filter { now.timeIntervalSince($0) < options.stableSeconds * 2 } + [now]
                    }
                    log("launcher: Stella crashed \(Int(sinceReady))s after ready (\(detail)); recent early crashes \(crashTimes.count)")
                    if crashTimes.count >= 2 {
                        crashTimes = []
                        failure = ("Stella crashed twice shortly after starting (\(detail)).", output)
                    } else {
                        continue
                    }
                case let .failed(reason, output):
                    failure = (reason, output)
                }
            } catch {
                // First line is the message; any detail (a command's output)
                // goes to the output pane.
                let lines = "\(error)".split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
                failure = (lines.first ?? "\(error)", Array(lines.dropFirst().suffix(40)))
            }

            guard let failure else { continue }
            progress.hide()
            log("launcher: failure: \(failure.reason)")
            switch recover(reason: failure.reason, output: failure.output) {
            case .quit:
                return 1
            case .retry:
                continue
            case .returnToKnownGood:
                do { try returnToKnownGood() } catch { log("recovery: return failed: \(error)") }
            case .reinstall:
                do { try reinstall() } catch { log("recovery: reinstall failed: \(error)") }
            }
        }
    }

    // MARK: Install, verify, prepare

    private func prepareForLaunch() throws -> URL {
        let fm = FileManager.default
        for dir in [paths.root, paths.logs, paths.runtimes, paths.bundles] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        let env = baseEnvironment()
        let git = try self.git ?? Install.ensureGit(paths: paths, baseEnv: env, progress: progress.show)
        self.git = git
        let signer = try self.signer ?? TreeSigner(paths: paths)
        self.signer = signer

        if !fm.fileExists(atPath: paths.app.appendingPathComponent(".git").path) {
            try Install.cloneSource(paths: paths, git: git, source: source, progress: progress.show)
            // The initial clone is signed at install.
            try signer.signHead(git: git, app: paths.app, expected: nil)
            state = LauncherState()
            state.installedAt = ISO8601DateFormatter().string(from: Date())
            state.save(paths)
        }

        let verdict = try signer.verifyHead(git: git, app: paths.app)
        guard case .signed = verdict else {
            log("verify: refused: \(verdict)")
            throw LauncherError(refusalMessage(verdict))
        }
        log("verify: HEAD signed and clean")

        let (bun, bunVersion) = try Install.ensureBun(
            paths: paths, baseEnv: env, localBun: options.localBun, progress: progress.show)
        let runtimes = Runtimes(bunBin: bun, bunVersion: bunVersion, git: git)
        self.runtimes = runtimes
        return try Prepare.run(paths: paths, runtimes: runtimes, env: baseEnvironment(),
                               state: &state, progress: progress.show)
    }

    private var source: Install.Source {
        if let source = options.source { return .explicit(source, ref: options.sourceRef) }
        return .upstream(backend: options.backend)
    }

    private func refusalMessage(_ verdict: TreeSigner.Verdict) -> String {
        switch verdict {
        case let .dirty(files):
            return "Stella's files were changed outside of Stella's updates, so it won't run them (\(files.count) changed: \(files.prefix(3).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")))."
        case .unsigned:
            return "This version of Stella wasn't installed through Stella's updates (it has no signature), so it won't run."
        case .badSignature:
            return "This version of Stella has an invalid signature, so it won't run."
        case .signed:
            return ""
        }
    }

    /// The environment for git, bun and Electron: the managed runtimes first
    /// on PATH, and none of the launcher's own secrets.
    private func baseEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let usesTestKey = !(env["STELLA_LAUNCHER_KEY_FILE"] ?? "").isEmpty
        var stripped = ["STELLA_LAUNCHER_KEY_FILE", "STELLA_LAUNCHER_ROOT", "ELECTRON_RUN_AS_NODE",
                        "STELLA_V2_DEV_DATA_DIR", "STELLA_APP_DIR", "STELLA_RUNTIME_STATE_DIR",
                        "STELLA_DEV_RESTART_REQUEST_FILE", "STELLA_DEV_USER_QUIT_REQUEST_FILE",
                        "STELLA_ELECTRON_DEV_RUNNER_PID", "STELLA_ELECTRON_READY_FILE", "NODE_OPTIONS"]
        // The dev harness (own profile, file-backed safeStorage, remote
        // debugging) passes through only for a test root signed with a test
        // key file: it opens Electron to debugging, so it must never apply
        // to an install whose key is the real keychain key.
        let harness = ["STELLA_DEV_HARNESS", "STELLA_DEV_HARNESS_STORAGE_KEY", "STELLA_V2_DEV_USER_DATA_DIR",
                       "STELLA_REMOTE_DEBUG_PORT", "STELLA_DEV_HARNESS_SESSION_TOKEN"]
        if !(paths.isolated && usesTestKey) { stripped += harness }
        for key in stripped {
            env.removeValue(forKey: key)
        }
        if paths.isolated {
            env.removeValue(forKey: "STELLA_DATA_DIR")
        }
        var front: [String] = []
        if let runtimes { front.append(runtimes.bunBin.deletingLastPathComponent().path) }
        if let root = git?.root { front.append(root.appendingPathComponent("bin").path) }
        let existing = env["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = (front + [existing]).joined(separator: ":")
        return env
    }

    private func electronEnvironment() -> [String: String] {
        var env = baseEnvironment()
        env["STELLA_LAUNCHER"] = "1"
        if let runtimes {
            env["STELLA_BUN_PATH"] = runtimes.bunBin.path
            for (key, value) in runtimes.git.runtimeEnv { env[key] = value }
        }
        if let signer { env["STELLA_LAUNCHER_PUBKEY"] = signer.publicKeySPKIBase64 }
        if paths.isolated {
            // A test root never touches the real profile or Stella home.
            env["STELLA_LAUNCHER_USER_DATA_DIR"] = paths.isolatedUserData.path
            env["STELLA_DATA_DIR"] = paths.isolatedHome.path
            env["STELLA_V2_DEV_DATA_DIR"] = paths.isolatedHome.path
        }
        return env
    }

    // MARK: Supervision

    enum Outcome {
        case quit
        case relaunch
        case crashed(sinceReady: TimeInterval, detail: String, output: [String])
        case failed(String, [String])
    }

    private func supervise(electronApp: URL) -> Outcome {
        guard let git, let signer else { return .failed("The launcher is not set up.", []) }
        let spawnedHead = (try? git.run(["rev-parse", "HEAD"], cwd: paths.app)) ?? ""
        let process: ElectronProcess
        do {
            process = try ElectronProcess(
                executable: electronApp.appendingPathComponent("Contents/MacOS/Electron"),
                // Stella doesn't use AppKit window restoration. Skipping it
                // keeps launch independent of the persistent-UI service, whose
                // XPC call at launch can block Electron's main thread forever.
                args: [paths.app.path, "-ApplePersistenceIgnoreState", "YES"],
                cwd: paths.app,
                env: electronEnvironment(),
                logFile: paths.electronLog)
        } catch {
            return .failed("Stella could not be started: \(error)", [])
        }
        current = process
        defer {
            current = nil
            process.closeChannel()
        }
        process.after(options.readyTimeout, "ready-timeout")

        var readyAt: Date?
        var pending: (String, [String])?
        var quitRequested = false
        /// The clean exit Electron announced; used if its teardown hangs.
        var announcedExit: Int32?
        while let event = process.events.next(until: nil) {
            switch event {
            case let .message(message):
                switch message["op"] as? String {
                case "ready":
                    guard readyAt == nil else { break }
                    readyAt = Date()
                    log("supervisor: ready")
                    process.after(options.stableSeconds, "stable")
                    if options.selfTest { process.after(options.hold, "self-test-quit") }
                case "sign":
                    handleSign(message, process: process, git: git, signer: signer)
                case "exiting":
                    let code = (message["code"] as? NSNumber)?.int32Value ?? 0
                    announcedExit = code
                    log("supervisor: Electron is exiting with \(code)")
                    process.after(10, "exit-grace")
                case "failed":
                    let reason = (message["reason"] as? String) ?? "unknown"
                    log("supervisor: Electron reported failure: \(reason)")
                    if pending == nil {
                        pending = ("Stella reported a problem: \(reason)", process.output.lastLines)
                        process.terminate()
                    }
                default:
                    log("supervisor: ignored message \(message)")
                }
            case let .timer(name):
                switch name {
                case "ready-timeout" where readyAt == nil && pending == nil:
                    log("supervisor: no ready within \(Int(options.readyTimeout))s")
                    pending = ("Stella didn't finish starting within \(Int(options.readyTimeout)) seconds.", process.output.lastLines)
                    process.terminate()
                case "stable" where pending == nil:
                    do {
                        try git.run(["update-ref", Launcher.knownGoodRef, spawnedHead], cwd: paths.app)
                        log("supervisor: \(Int(options.stableSeconds))s stable; \(Launcher.knownGoodRef) = \(spawnedHead.prefix(12))")
                    } catch {
                        log("supervisor: could not mark known-good: \(error)")
                    }
                case "self-test-quit":
                    log("supervisor: self-test asks Electron to quit")
                    quitRequested = true
                    process.send(["op": "quit"])
                    process.after(30, "quit-timeout")
                case "quit-timeout" where announcedExit == nil:
                    log("supervisor: Electron did not quit in time; terminating")
                    process.terminate()
                case "exit-grace":
                    log("supervisor: Electron's teardown is still running 10s after it announced its exit; terminating")
                    process.terminate()
                default:
                    break
                }
            case let .exited(code, signal):
                // Give the output reader a moment to drain the pipe.
                Thread.sleep(forTimeInterval: 0.3)
                let output = process.output.lastLines
                let detail = signal != 0 ? "signal \(signal)" : "exit \(code)"
                log("supervisor: Electron exited (\(detail))")
                if let pending { return .failed(pending.0, output) }
                // A hung teardown killed after the announcement counts as the
                // announced exit.
                let code = announcedExit ?? (signal == 0 ? code : -1)
                let signal = announcedExit != nil ? 0 : signal
                if signal == 0 && code == Launcher.relaunchExitCode { return .relaunch }
                if quitRequested && !(signal == 0 && code == 0) {
                    return .failed("Stella didn't quit cleanly when asked (\(detail)).", output)
                }
                if signal == 0 && code == 0 {
                    if readyAt == nil && options.selfTest {
                        return .failed("Stella quit before it finished starting.", output)
                    }
                    return .quit
                }
                guard let readyAt else {
                    return .failed("Stella stopped before it finished starting (\(detail)).", output)
                }
                return .crashed(sinceReady: Date().timeIntervalSince(readyAt), detail: detail, output: output)
            }
        }
        return .failed("Lost track of Stella.", [])
    }

    private func handleSign(_ message: [String: Any], process: ElectronProcess, git: GitTool, signer: TreeSigner) {
        let id = message["id"] ?? NSNull()
        do {
            let head = try signer.signHead(git: git, app: paths.app, expected: message["commit"] as? String)
            process.send(["op": "sign-result", "id": id, "ok": true, "commit": head])
        } catch {
            log("signing: refused: \(error)")
            process.send(["op": "sign-result", "id": id, "ok": false, "error": "\(error)"])
        }
    }

    // MARK: Recovery

    private func hasKnownGood() -> Bool {
        guard let git else { return false }
        return (try? git.raw(["rev-parse", "--verify", "--quiet", "\(Launcher.knownGoodRef)^{commit}"], cwd: paths.app).code) == 0
    }

    private func recover(reason: String, output: [String]) -> RecoveryChoice {
        recoveryCount += 1
        var automation: RecoveryWindow.Automation?
        var forcedExit = false
        if options.selfTest {
            if let choice = options.recoveryChoice, recoveryCount == 1 {
                automation = .init(choice: choice, delay: 2)
            } else {
                automation = .init(choice: .quit, delay: 1.5)
                forcedExit = true
            }
        }
        let capture = options.captureDir?.appendingPathComponent("recovery-\(recoveryCount).png")
        let choice = RecoveryWindow().present(
            reason: reason, output: output, hasKnownGood: hasKnownGood(),
            captureTo: capture, automation: automation)
        if forcedExit { log("launcher: self-test failed: \(reason)") }
        return choice
    }

    /// A forward commit back to the known-good tree: nothing is rewritten, so
    /// the fork still fast-forwards. Uncommitted edits are stashed, not lost.
    private func returnToKnownGood() throws {
        guard let git, let signer else { return }
        guard hasKnownGood() else {
            try reinstall()
            return
        }
        let app = paths.app
        if !(try signer.changedFiles(git: git, app: app)).isEmpty {
            let stamp = ISO8601DateFormatter().string(from: Date())
            try git.run(["stash", "push", "--include-untracked", "-m", "Stella recovery \(stamp)"],
                        cwd: app, extraEnv: GitTool.identityEnv)
            log("recovery: stashed uncommitted changes")
        }
        let head = try git.run(["rev-parse", "HEAD"], cwd: app)
        let knownTree = try git.run(["rev-parse", "\(Launcher.knownGoodRef)^{tree}"], cwd: app)
        let headTree = try git.run(["rev-parse", "HEAD^{tree}"], cwd: app)
        if knownTree != headTree {
            let commit = try git.run(
                ["commit-tree", knownTree, "-p", head, "-m", "Return to the last working version"],
                cwd: app, extraEnv: GitTool.identityEnv)
            try git.run(["merge", "--ff-only", commit], cwd: app)
            log("recovery: returned to known-good tree \(knownTree.prefix(12)) as \(commit.prefix(12))")
        }
        try signer.signHead(git: git, app: app, expected: nil)
    }

    /// No known-good version yet: move the checkout aside and clone again.
    private func reinstall() throws {
        guard let git, let signer else { return }
        let fm = FileManager.default
        if fm.fileExists(atPath: paths.app.path) {
            let stamp = Int(Date().timeIntervalSince1970)
            let aside = paths.root.appendingPathComponent("app.previous-\(stamp)")
            try fm.moveItem(at: paths.app, to: aside)
            log("recovery: moved the old checkout to \(aside.path)")
        }
        try Install.cloneSource(paths: paths, git: git, source: source, progress: progress.show)
        try signer.signHead(git: git, app: paths.app, expected: nil)
        state = LauncherState()
        state.installedAt = ISO8601DateFormatter().string(from: Date())
        state.save(paths)
    }
}
