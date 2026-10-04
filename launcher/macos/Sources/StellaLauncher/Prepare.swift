import Foundation

/// Runs on install, after a relaunch request and after a rollback: dependency
/// install when the lockfile changed, the native asset downloads when HEAD
/// changed, and the Electron app identity for the installed Electron version.
enum Prepare {
    static func run(
        paths: LauncherPaths,
        runtimes: Runtimes,
        env: [String: String],
        state: inout LauncherState,
        progress: (String) -> Void
    ) throws -> URL {
        let app = paths.app
        let lockHash = try sha256File(app.appendingPathComponent("bun.lock"))
        let electronPackage = app.appendingPathComponent("node_modules/electron/package.json")
        if state.bunLockHash != lockHash || !FileManager.default.fileExists(atPath: electronPackage.path) {
            progress("Installing Stella's dependencies…")
            log("prepare: bun install --frozen-lockfile (lock \(lockHash.prefix(12)))")
            let started = Date()
            // Dependencies only: the postinstall's asset downloads are
            // prepare-install.mjs's job (under the managed Bun, with a timeout).
            var installEnv = env
            installEnv["STELLA_SKIP_BROWSER_HYDRATE"] = "1"
            installEnv["STELLA_SKIP_OFFICE_HYDRATE"] = "1"
            let result = try Shell.run(runtimes.bunBin.path, ["install", "--frozen-lockfile"],
                                       cwd: app, env: installEnv, outputFile: paths.installLog,
                                       timeout: 30 * 60)
            guard result.code == 0 else {
                throw LauncherError("bun install failed (exit \(result.code)):\n\(lastLines(result.stderr, 20))")
            }
            log("prepare: bun install finished in \(Int(Date().timeIntervalSince(started)))s")
            state.bunLockHash = lockHash
            state.save(paths)
        }

        let head = try runtimes.git.run(["rev-parse", "HEAD"], cwd: app)
        let script = app.appendingPathComponent("packages/desktop/scripts/prepare-install.mjs")
        if state.preparedHead != head, FileManager.default.fileExists(atPath: script.path) {
            progress("Preparing Stella…")
            log("prepare: prepare-install.mjs for \(head.prefix(12))")
            // The assets it fetches are optional features (computer use, the
            // browser, office previews); a failure or timeout is logged, not
            // fatal, and retried on the next launch.
            let timeout = Options.seconds("STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS", 10 * 60)
            let result = try? Shell.run(runtimes.bunBin.path, [script.path],
                                        cwd: app, env: env, outputFile: paths.installLog, timeout: timeout)
            if let result, result.code == 0 {
                state.preparedHead = head
                state.save(paths)
            } else {
                let detail = result.map { "exit \($0.code)" } ?? "timed out after \(Int(timeout))s"
                log("prepare: prepare-install.mjs incomplete (\(detail)):\n\(lastLines(result?.stderr ?? "", 10))")
            }
        }

        return try ElectronIdentity.ensure(paths: paths, env: env, progress: progress)
    }

    static func lastLines(_ text: String, _ count: Int) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count).joined(separator: "\n")
    }
}

/// `bundles/electron-<v>/Stella.app`: Electron as macOS knows Stella (bundle
/// id, name, icon, microphone string). Normally the Developer ID-signed copy
/// CI publishes per Electron version (.github/workflows/build-electron-identity.yml):
/// its identity is the same across versions and reinstalls, so the Keychain
/// item and privacy grants keep trusting it. When that can't be fetched, a
/// local copy of the installed Electron.app with an ad-hoc signature, which
/// macOS treats as a new app for every Electron version.
enum ElectronIdentity {
    static let bundleId = "com.stella.app"
    static let appName = "Stella"
    static let microphoneUsage = "Stella uses your microphone for voice conversations."
    /// Bump when the patch below changes, to rebuild existing bundles.
    static let revision = 1
    static let signedBase = "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/electron-identity"
    static let requirement =
        "anchor apple generic and identifier \"com.stella.app\" and certificate leaf[subject.OU] = \"7UVYHQ763X\""
    #if arch(arm64)
    static let arch = "arm64"
    #else
    static let arch = "x64"
    #endif

    static func ensure(paths: LauncherPaths, env: [String: String], progress: (String) -> Void) throws -> URL {
        let app = paths.app
        let electronDir = app.appendingPathComponent("node_modules/electron").resolvingSymlinksInPath()
        let packageData = try Data(contentsOf: electronDir.appendingPathComponent("package.json"))
        guard let package = try JSONSerialization.jsonObject(with: packageData) as? [String: Any],
              let version = package["version"] as? String
        else { throw LauncherError("Could not read the installed Electron version.") }
        let source = electronDir.appendingPathComponent("dist/Electron.app")
        guard FileManager.default.fileExists(atPath: source.appendingPathComponent("Contents/MacOS/Electron").path) else {
            throw LauncherError("Electron \(version) is not installed (missing \(source.path)).")
        }

        let icon = app.appendingPathComponent("packages/desktop/build/icon.icns")
        let iconHash = (try? sha256File(icon)) ?? "none"
        let dir = paths.bundles.appendingPathComponent("electron-\(version)")
        let target = dir.appendingPathComponent("Stella.app")
        let marker = dir.appendingPathComponent("identity.json")
        let signedMarker = "{\"electron\":\"\(version)\",\"signed\":true}"
        let expected = "{\"electron\":\"\(version)\",\"icon\":\"\(iconHash)\",\"revision\":\(revision)}"
        let current = try? String(contentsOf: marker, encoding: .utf8)
        if FileManager.default.fileExists(atPath: target.path), current == signedMarker {
            return target
        }
        do {
            try installSigned(version: version, dir: dir, target: target, env: env, progress: progress)
            try signedMarker.write(to: marker, atomically: true, encoding: .utf8)
            log("identity: \(target.path) ready (Developer ID)")
            return target
        } catch {
            log("identity: signed Stella.app for Electron \(version) unavailable: \(error)")
        }
        if FileManager.default.fileExists(atPath: target.path), current == expected {
            return target
        }

        progress("Setting up Stella.app…")
        log("identity: building \(target.path) from Electron \(version)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let staging = dir.appendingPathComponent("Stella.app.partial")
        try? FileManager.default.removeItem(at: staging)
        let copy = try Shell.run("/usr/bin/ditto", [source.path, staging.path], env: env)
        guard copy.code == 0 else { throw LauncherError("Could not copy Electron.app: \(copy.stderr)") }

        let plistURL = staging.appendingPathComponent("Contents/Info.plist")
        let plistData = try Data(contentsOf: plistURL)
        var format = PropertyListSerialization.PropertyListFormat.xml
        guard var plist = try PropertyListSerialization.propertyList(
            from: plistData, options: [], format: &format) as? [String: Any]
        else { throw LauncherError("Electron's Info.plist is unreadable.") }
        // The executable keeps its name: Electron decides app.isPackaged from
        // it, and launcher runs are source runs.
        plist["CFBundleExecutable"] = "Electron"
        plist["CFBundleName"] = appName
        plist["CFBundleDisplayName"] = appName
        plist["CFBundleIdentifier"] = bundleId
        plist["NSMicrophoneUsageDescription"] = microphoneUsage
        let patched = try PropertyListSerialization.data(fromPropertyList: plist, format: format, options: 0)
        try patched.write(to: plistURL)

        if FileManager.default.fileExists(atPath: icon.path) {
            let targetIcon = staging.appendingPathComponent("Contents/Resources/electron.icns")
            try? FileManager.default.removeItem(at: targetIcon)
            try FileManager.default.copyItem(at: icon, to: targetIcon)
        }

        let sign = try Shell.run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", staging.path], env: env)
        guard sign.code == 0 else { throw LauncherError("codesign failed: \(sign.stderr)") }

        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: staging, to: target)
        try expected.write(to: marker, atomically: true, encoding: .utf8)
        log("identity: \(target.path) ready")
        return target
    }

    /// Download CI's signed Stella.app for this Electron version and keep it
    /// only if its checksum and Developer ID signature check out.
    private static func installSigned(
        version: String, dir: URL, target: URL, env: [String: String], progress: (String) -> Void
    ) throws {
        let name = "Stella-darwin-\(arch).zip"
        guard let sumURL = URL(string: "\(signedBase)/\(version)/\(name).sha256"),
              let zipURL = URL(string: "\(signedBase)/\(version)/\(name)")
        else { throw LauncherError("Bad signed bundle URL.") }
        let (sumData, sumResponse) = try Net.fetch(URLRequest(url: sumURL))
        guard sumResponse.statusCode == 200 else { throw LauncherError("HTTP \(sumResponse.statusCode) for \(name).sha256") }
        let sha = String(decoding: sumData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        progress("Setting up Stella.app…")
        log("identity: downloading signed Stella.app for Electron \(version)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let zip = dir.appendingPathComponent(name)
        try Net.download(zipURL, to: zip, sha256: sha)
        defer { try? FileManager.default.removeItem(at: zip) }
        let unpacked = dir.appendingPathComponent("signed.partial")
        try? FileManager.default.removeItem(at: unpacked)
        let unzip = try Shell.run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path], env: env)
        guard unzip.code == 0 else { throw LauncherError("Could not unpack \(name): \(unzip.stderr)") }
        defer { try? FileManager.default.removeItem(at: unpacked) }
        let app = unpacked.appendingPathComponent("Stella.app")
        let verify = try Shell.run(
            "/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R=\(requirement)", app.path], env: env)
        guard verify.code == 0 else { throw LauncherError("Signature check failed: \(verify.stderr)") }
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: app, to: target)
    }
}
