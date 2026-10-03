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

/// `bundles/electron-<v>/Stella.app`: a copy of the installed Electron.app
/// that macOS knows as Stella (bundle id, name, icon, microphone string) with
/// an ad-hoc signature. Keyed per Electron version, so permission grants
/// survive source updates. Ported from
/// packages/desktop/scripts/lib/macos-dev-permission-identity.mjs, with the
/// product bundle id instead of the dev one.
enum ElectronIdentity {
    static let bundleId = "com.stella.app"
    static let appName = "Stella"
    static let microphoneUsage = "Stella uses your microphone for voice conversations."
    /// Bump when the patch below changes, to rebuild existing bundles.
    static let revision = 1

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
        let expected = "{\"electron\":\"\(version)\",\"icon\":\"\(iconHash)\",\"revision\":\(revision)}"
        if FileManager.default.fileExists(atPath: target.path),
           (try? String(contentsOf: marker, encoding: .utf8)) == expected {
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
}
