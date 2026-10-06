import AppKit
import Darwin
import Foundation

/// One launcher per install root: an flock on `launcher.lock`, O_CLOEXEC so
/// nothing the launcher spawns inherits it.
enum InstanceLock {
    private static var fd: Int32 = -1

    /// Take the lock, retrying for `wait` seconds (a launcher handing over to
    /// this one may still be on its way out).
    static func acquire(_ url: URL, wait: TimeInterval) -> Bool {
        if fd < 0 { fd = open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600) }
        guard fd >= 0 else { return false }
        let deadline = Date().addingTimeInterval(wait)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            if Date() >= deadline { return false }
            usleep(100_000)
        }
        return true
    }

    static func release() {
        if fd >= 0 { flock(fd, LOCK_UN) }
    }
}

/// Keeps the launcher itself current. CI publishes every launcher build to
/// R2 launcher/stable/ with its run number in `VERSION`; a newer one is
/// downloaded, checked (sha256, Developer ID, `--version`) and moved into
/// the running bundle's place on disk, so it takes over at the next start:
/// the next time the user opens Stella, or right away when Electron restarts
/// for an app update. All of it runs in the background and only logs.
final class LauncherUpdater {
    static let defaultBase = "\(Deployment.releasesURL)/launcher/stable"
    static let asset = "Stella-macos.zip"
    static let requirement =
        "anchor apple generic and certificate leaf[subject.OU] = \"\(Deployment.appleTeamID)\" and identifier \"com.stella.launcher\""
    static let interval: TimeInterval = 6 * 60 * 60

    /// CFBundleVersion, which build.sh sets to CI's run number; 0 for a local build.
    static var ownVersion: Int {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
            .flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } ?? 0
    }

    private let paths: LauncherPaths
    /// Where VERSION, SHA256SUMS and the zip live; nil when this run never checks.
    private let base: String?
    private let requirement: String
    private let queue = DispatchQueue(label: "launcher-update", qos: .utility)
    /// Guards `staged` and the bundle on disk while it is swapped or handed over.
    private let lock = NSLock()
    private var staged: Int?
    /// Queue only: the bundle can't be replaced, so this run stops checking.
    private var stopped = false

    private var work: URL { paths.root.appendingPathComponent("launcher-update") }
    private var previousDir: URL { paths.root.appendingPathComponent("launcher-previous") }
    var holdFile: URL { paths.root.appendingPathComponent("launcher-handover-hold.json") }

    /// Checks run only for a CI build installed for real. Tests point
    /// `STELLA_LAUNCHER_UPDATE_URL` at their own server, which may also
    /// relax the signature requirement for ad-hoc builds.
    init(paths: LauncherPaths, selfTest: Bool) {
        self.paths = paths
        let env = ProcessInfo.processInfo.environment
        let override = (env["STELLA_LAUNCHER_UPDATE_URL"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !override.isEmpty {
            base = override.hasSuffix("/") ? String(override.dropLast()) : override
            let testRequirement = (env["STELLA_LAUNCHER_UPDATE_REQUIREMENT"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            requirement = testRequirement.isEmpty ? Self.requirement : testRequirement
        } else {
            base = Self.ownVersion == 0 || selfTest || paths.isolated ? nil : Self.defaultBase
            requirement = Self.requirement
        }
    }

    var stagedVersion: Int? {
        lock.lock()
        defer { lock.unlock() }
        return staged
    }

    func start() {
        guard let base else {
            log("update: off (version \(Self.ownVersion))")
            return
        }
        let delay = Options.seconds("STELLA_LAUNCHER_UPDATE_DELAY_SECONDS", 60)
        log("update: version \(Self.ownVersion); checking \(base) in \(Int(delay))s, then every \(Int(Self.interval / 3600))h")
        schedule(after: delay)
    }

    /// Stella started and became ready under this launcher: the bundle it
    /// replaced is no longer needed. Kept while this run has staged one,
    /// since then it is the launcher that is running.
    func startedSuccessfully() {
        queue.async { [self] in
            guard stagedVersion == nil, FileManager.default.fileExists(atPath: previousDir.path) else { return }
            do {
                try FileManager.default.removeItem(at: previousDir)
                log("update: removed the previous launcher")
            } catch {
                log("update: could not remove the previous launcher: \(error)")
            }
        }
    }

    // MARK: Checking

    private func schedule(after delay: TimeInterval) {
        // Wall time, so a sleeping Mac still checks every 6 hours of the clock.
        queue.asyncAfter(wallDeadline: .now() + delay) { [self] in
            check()
            if !stopped { schedule(after: Self.interval) }
        }
    }

    private func check() {
        guard let base else { return }
        let fm = FileManager.default
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app" else {
            log("update: not running from an app bundle (\(bundle.path)); not updating")
            stopped = true
            return
        }
        guard fm.isWritableFile(atPath: bundle.path),
              fm.isWritableFile(atPath: bundle.deletingLastPathComponent().path)
        else {
            log("update: \(bundle.path) is not writable; not updating this run")
            stopped = true
            return
        }

        log("update: checking")
        do {
            let latest = try fetchVersion(base)
            let current = max(Self.ownVersion, stagedVersion ?? 0)
            guard latest > current else {
                log("update: up to date (latest \(latest), have \(current))")
                return
            }
            log("update: \(latest) available")
            try? fm.removeItem(at: work)
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            defer { try? fm.removeItem(at: work) }

            let sha = try expectedSHA(base)
            guard let zipURL = URL(string: "\(base)/\(Self.asset)") else { throw LauncherError("bad update URL") }
            let zip = work.appendingPathComponent(Self.asset)
            try Net.download(zipURL, to: zip, sha256: sha)
            log("update: downloaded \(latest) (sha256 \(sha.prefix(12)))")
            let unpacked = work.appendingPathComponent("unpacked")
            let unzip = try Shell.run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path], env: Self.toolEnv, timeout: 300)
            guard unzip.code == 0 else { throw LauncherError("could not unpack \(Self.asset): \(Self.trim(unzip.stderr))") }
            let app = unpacked.appendingPathComponent("Stella.app")
            guard fm.fileExists(atPath: app.path) else { throw LauncherError("\(Self.asset) has no Stella.app") }

            try verify(app, version: latest)
            log("update: verified \(latest)")
            try stage(app, version: latest, at: bundle)
            log("update: staged \(latest) at \(bundle.path); the previous launcher is in \(previousDir.path)")
        } catch let error as StageRefused {
            log("update: \(error.description); not updating this run")
            stopped = true
        } catch {
            log("update: failed: \(error)")
        }
    }

    private func fetchVersion(_ base: String) throws -> Int {
        let text = try fetchText("\(base)/VERSION")
        guard let version = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw LauncherError("VERSION is not a number: \(text.prefix(40))")
        }
        return version
    }

    /// `sha256sum` format: `<hex>  <name>` (or ` *<name>` for binary mode).
    private func expectedSHA(_ base: String) throws -> String {
        let sums = try fetchText("\(base)/SHA256SUMS")
        for line in sums.split(whereSeparator: \.isNewline) {
            let fields = line.split(maxSplits: 1, whereSeparator: \.isWhitespace)
            guard fields.count == 2 else { continue }
            var name = fields[1].trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("*") { name.removeFirst() }
            let hash = fields[0].lowercased()
            if name == Self.asset, hash.count == 64, hash.allSatisfy(\.isHexDigit) { return hash }
        }
        throw LauncherError("SHA256SUMS has no \(Self.asset)")
    }

    private func fetchText(_ address: String) throws -> String {
        guard let url = URL(string: address) else { throw LauncherError("bad URL \(address)") }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try Net.fetch(request)
        guard response.statusCode == 200 else { throw LauncherError("HTTP \(response.statusCode) for \(url.lastPathComponent)") }
        return String(decoding: data, as: UTF8.self)
    }

    /// Signed by us (Developer ID, our team, our identifier), sealed, and it
    /// runs and says it is the version VERSION announced.
    private func verify(_ app: URL, version: Int) throws {
        let sign = try Shell.run(
            "/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R=\(requirement)", app.path],
            env: Self.toolEnv, timeout: 120)
        guard sign.code == 0 else { throw LauncherError("signature check failed: \(Self.trim(sign.stderr))") }
        let executable = app.appendingPathComponent("Contents/MacOS/StellaLauncher")
        let probe = try Shell.run(executable.path, ["--version"], env: Self.toolEnv, timeout: 30)
        let reported = probe.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard probe.code == 0, reported == String(version) else {
            throw LauncherError("the new launcher's --version said \"\(reported.prefix(40))\" (exit \(probe.code)), expected \(version)")
        }
    }

    // MARK: Staging

    private struct StageRefused: Error, CustomStringConvertible {
        let description: String
    }

    /// Move the verified bundle into the running one's place. The running
    /// process keeps its mapped image; the bundle it came from goes to
    /// `launcher-previous/` until a later start under the new one succeeds.
    private func stage(_ app: URL, version: Int, at bundle: URL) throws {
        let fm = FileManager.default
        lock.lock()
        defer { lock.unlock() }
        // The first stage of a run sets the running bundle aside; a later one
        // replaces the earlier, never-started update.
        let aside: URL
        if staged == nil {
            try? fm.removeItem(at: previousDir)
            try fm.createDirectory(at: previousDir, withIntermediateDirectories: true)
            aside = previousDir.appendingPathComponent("Stella.app")
        } else {
            aside = work.appendingPathComponent("replaced.app")
        }
        do {
            try fm.moveItem(at: bundle, to: aside)
        } catch {
            throw StageRefused(description: "could not move \(bundle.path) aside: \(error.localizedDescription)")
        }
        do {
            try fm.moveItem(at: app, to: bundle)
        } catch {
            if (try? fm.moveItem(at: aside, to: bundle)) == nil {
                log("update: could not put \(aside.path) back at \(bundle.path)")
            }
            throw LauncherError("could not move the update into \(bundle.path): \(error.localizedDescription)")
        }
        staged = version
    }

    // MARK: Handover

    /// Electron is restarting for an app update and a newer launcher is on
    /// disk: open it with `--start` (and the held frame, so the update hold
    /// carries over) and let it take over. True once the new launcher is
    /// running or owns the lock; false to restart Stella with this launcher.
    func handOver(to version: Int, hold: [String: Any]?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        log("update: handing over to \(version)")
        let bundle = Bundle.main.bundleURL
        var args = ["--start"]
        if let hold, JSONSerialization.isValidJSONObject(hold),
           let data = try? JSONSerialization.data(withJSONObject: hold),
           (try? data.write(to: holdFile, options: .atomic)) != nil {
            args += ["--hold-window", holdFile.path]
        }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = false
        config.addsToRecentItems = false
        config.arguments = args
        // Only Stella's own settings (test roots and keys) carry over.
        config.environment = ProcessInfo.processInfo.environment.filter { $0.key.hasPrefix("STELLA_") }

        // It takes the lock as it starts (retrying for a few seconds).
        InstanceLock.release()
        let opened = DispatchSemaphore(value: 0)
        var failure: Error?
        DispatchQueue.main.async {
            NSWorkspace.shared.openApplication(at: bundle, configuration: config) { app, error in
                if let error {
                    failure = error
                } else if let app {
                    log("update: launcher \(version) started as pid \(app.processIdentifier)")
                }
                opened.signal()
            }
        }
        if opened.wait(timeout: .now() + 20) == .timedOut {
            failure = LauncherError("no answer from Launch Services within 20s")
        }
        if let failure {
            log("update: handover to \(version) failed: \(failure)")
            guard InstanceLock.acquire(paths.lockFile, wait: 0) else {
                log("update: the new launcher took the lock anyway; leaving Stella to it")
                return true
            }
            try? FileManager.default.removeItem(at: holdFile)
            return false
        }
        // This launcher's hold stays up while the new one starts and shows its own.
        Thread.sleep(forTimeInterval: 2)
        return true
    }

    // MARK: Helpers

    private static let toolEnv = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

    private static func trim(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).suffix(400))
    }
}
