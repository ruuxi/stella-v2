import Foundation

/// The managed git (`runtimes/git-<v>`), with the environment it needs to be
/// relocatable. The same variables go to Electron, matching what the packaged
/// app's bundled-runtime-environment.ts sets.
struct GitTool {
    let bin: String
    let root: URL?
    let baseEnv: [String: String]

    var runtimeEnv: [String: String] {
        guard let root else { return ["STELLA_GIT_BIN": bin] }
        return [
            "STELLA_GIT_BIN": bin,
            "LOCAL_GIT_DIRECTORY": root.path,
            "GIT_EXEC_PATH": root.appendingPathComponent("libexec/git-core").path,
            "GIT_TEMPLATE_DIR": root.appendingPathComponent("share/git-core/templates").path,
        ]
    }

    func raw(_ args: [String], cwd: URL?, extraEnv: [String: String] = [:]) throws -> ShellResult {
        var env = baseEnv
        for (key, value) in runtimeEnv where key != "STELLA_GIT_BIN" && key != "LOCAL_GIT_DIRECTORY" {
            env[key] = value
        }
        env["GIT_TERMINAL_PROMPT"] = "0"
        for (key, value) in extraEnv { env[key] = value }
        return try Shell.run(bin, args, cwd: cwd, env: env)
    }

    @discardableResult
    func run(_ args: [String], cwd: URL?, extraEnv: [String: String] = [:]) throws -> String {
        let result = try raw(args, cwd: cwd, extraEnv: extraEnv)
        guard result.code == 0 else {
            let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw LauncherError("git \(args.first ?? "") failed: \(detail.isEmpty ? "exit \(result.code)" : detail)")
        }
        return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Commits and notes the launcher makes carry Stella's identity.
    static let identityEnv: [String: String] = [
        "GIT_AUTHOR_NAME": "Stella",
        "GIT_AUTHOR_EMAIL": "stella@localhost",
        "GIT_COMMITTER_NAME": "Stella",
        "GIT_COMMITTER_EMAIL": "stella@localhost",
    ]
}

struct Runtimes {
    let bunBin: URL
    let bunVersion: String
    let git: GitTool
}

enum Install {
    static func ensureGit(paths: LauncherPaths, baseEnv: [String: String], progress: (String) -> Void) throws -> GitTool {
        let root = paths.runtimes.appendingPathComponent("git-\(Pins.gitVersion)")
        let bin = root.appendingPathComponent("bin/git")
        if FileManager.default.isExecutableFile(atPath: bin.path) {
            return GitTool(bin: bin.path, root: root, baseEnv: baseEnv)
        }
        guard let asset = Pins.git[Pins.platformKey], let url = URL(string: asset.url) else {
            throw LauncherError("No git runtime for \(Pins.platformKey).")
        }
        progress("Downloading git \(Pins.gitVersion)…")
        log("install: downloading git \(Pins.gitVersion) from \(asset.url)")
        try FileManager.default.createDirectory(at: paths.runtimes, withIntermediateDirectories: true)
        let archive = paths.runtimes.appendingPathComponent("git-\(Pins.gitVersion).tar.gz")
        try Net.download(url, to: archive, sha256: asset.sha256)
        let staging = paths.runtimes.appendingPathComponent(".git-\(Pins.gitVersion).partial")
        try? FileManager.default.removeItem(at: staging)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let untar = try Shell.run("/usr/bin/tar", ["-xzf", archive.path, "-C", staging.path], env: baseEnv)
        guard untar.code == 0 else { throw LauncherError("Could not unpack git: \(untar.stderr)") }
        try? FileManager.default.removeItem(at: archive)
        try? FileManager.default.removeItem(at: root)
        try FileManager.default.moveItem(at: staging, to: root)
        let git = GitTool(bin: bin.path, root: root, baseEnv: baseEnv)
        log("install: git ready: \(try git.run(["--version"], cwd: nil))")
        return git
    }

    /// Bun from the version baked into the launcher, or the one a signed tree
    /// asks for in `packages/desktop/launcher.json`:
    /// `{"bun": {"version": "1.4.1", "assets": {"darwin-arm64": {"url", "sha256", "member"}}}}`.
    static func ensureBun(paths: LauncherPaths, baseEnv: [String: String], localBun: String?, progress: (String) -> Void) throws -> (URL, String) {
        var version = Pins.bunVersion
        var asset = Pins.bun[Pins.platformKey]
        if let requested = requestedBun(paths: paths) {
            version = requested.0
            asset = requested.1
        }

        if let localBun {
            // Offline/testing: adopt an existing Bun binary instead of downloading.
            let probe = try Shell.run(localBun, ["--version"], env: baseEnv)
            let localVersion = probe.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            guard probe.code == 0, !localVersion.isEmpty else { throw LauncherError("\(localBun) is not a working bun.") }
            let dir = paths.runtimes.appendingPathComponent("bun-\(localVersion)")
            let bin = dir.appendingPathComponent("bun")
            if !FileManager.default.isExecutableFile(atPath: bin.path) {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: URL(fileURLWithPath: localBun).resolvingSymlinksInPath(), to: bin)
                log("install: adopted local bun \(localVersion) from \(localBun)")
            }
            return (bin, localVersion)
        }

        let dir = paths.runtimes.appendingPathComponent("bun-\(version)")
        let bin = dir.appendingPathComponent("bun")
        if FileManager.default.isExecutableFile(atPath: bin.path) {
            return (bin, version)
        }
        guard let asset, let url = URL(string: asset.url) else {
            throw LauncherError("No Bun \(version) for \(Pins.platformKey).")
        }
        progress("Downloading Bun \(version)…")
        log("install: downloading bun \(version) from \(asset.url)")
        try FileManager.default.createDirectory(at: paths.runtimes, withIntermediateDirectories: true)
        let archive = paths.runtimes.appendingPathComponent("bun-\(version).zip")
        try Net.download(url, to: archive, sha256: asset.sha256)
        let staging = paths.runtimes.appendingPathComponent(".bun-\(version).partial")
        try? FileManager.default.removeItem(at: staging)
        let unzip = try Shell.run("/usr/bin/ditto", ["-x", "-k", archive.path, staging.path], env: baseEnv)
        guard unzip.code == 0 else { throw LauncherError("Could not unpack bun: \(unzip.stderr)") }
        let member = staging.appendingPathComponent(asset.member ?? "bun")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: bin)
        try FileManager.default.moveItem(at: member, to: bin)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)
        try? FileManager.default.removeItem(at: staging)
        try? FileManager.default.removeItem(at: archive)
        log("install: bun \(version) ready")
        return (bin, version)
    }

    private static func requestedBun(paths: LauncherPaths) -> (String, Pins.Asset)? {
        let manifest = paths.app.appendingPathComponent("packages/desktop/launcher.json")
        guard let data = try? Data(contentsOf: manifest),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let bun = json["bun"] as? [String: Any],
              let version = bun["version"] as? String,
              let assets = bun["assets"] as? [String: Any],
              let entry = assets[Pins.platformKey] as? [String: Any],
              let url = entry["url"] as? String,
              let sha = entry["sha256"] as? String
        else { return nil }
        return (version, Pins.Asset(url: url, sha256: sha, member: entry["member"] as? String))
    }

    enum Source {
        /// `POST <backend>/api/app-source/bootstrap` → upstream remote + read token.
        case upstream(backend: String)
        /// A local path or git URL (testing).
        case explicit(String, ref: String?)
    }

    /// Clone the app source into `app/`. The checkout is staged beside it and
    /// renamed into place, so an interrupted install never leaves half a tree.
    static func cloneSource(paths: LauncherPaths, git: GitTool, source: Source, progress: (String) -> Void) throws {
        progress("Downloading Stella…")
        let staging = paths.root.appendingPathComponent("app.partial")
        try? FileManager.default.removeItem(at: staging)
        var args = ["clone", "--origin", Pins.upstreamRemoteName]
        var env: [String: String] = [:]
        let remote: String
        switch source {
        case let .explicit(location, ref):
            remote = location
            if let ref { args += ["--branch", ref] }
        case let .upstream(backend):
            let access = try bootstrapAccess(backend: backend)
            remote = access.remote
            args += ["--branch", Pins.upstreamBranch]
            // Through the environment, so the token stays out of argv and
            // isn't written to the clone's config.
            env = [
                "GIT_CONFIG_COUNT": "2",
                "GIT_CONFIG_KEY_0": "http.extraHeader",
                "GIT_CONFIG_VALUE_0": "Authorization: Bearer \(access.token)",
                "GIT_CONFIG_KEY_1": "protocol.version",
                "GIT_CONFIG_VALUE_1": "1",
            ]
        }
        log("install: cloning \(remote)")
        try git.run(args + [remote, staging.path], cwd: paths.root, extraEnv: env)
        try FileManager.default.moveItem(at: staging, to: paths.app)
        log("install: source at \(try git.run(["rev-parse", "HEAD"], cwd: paths.app))")
    }

    private static func bootstrapAccess(backend: String) throws -> (remote: String, token: String) {
        let trimmed = backend.hasSuffix("/") ? String(backend.dropLast()) : backend
        guard let url = URL(string: "\(trimmed)/api/app-source/bootstrap") else {
            throw LauncherError("Invalid backend URL \(backend).")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        log("install: POST \(url.absoluteString)")
        let (data, response) = try Net.fetch(request)
        guard response.statusCode == 200 else {
            throw LauncherError("The app source bootstrap returned HTTP \(response.statusCode).")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LauncherError("The app source bootstrap returned an unexpected body.")
        }
        // Accept `{remote, token}` or `{upstream: {remote, token}}`.
        let body = (json["upstream"] as? [String: Any]) ?? json
        guard let remote = body["remote"] as? String, let token = body["token"] as? String else {
            throw LauncherError("The app source bootstrap response has no remote and token.")
        }
        return (remote, token)
    }
}
