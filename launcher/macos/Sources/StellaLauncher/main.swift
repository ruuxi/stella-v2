import AppKit
import Darwin
import Foundation

let usage = """
usage: StellaLauncher [--self-test] [--source <path|git url>] [--source-ref <ref>]
                      [--backend <url>] [--bun <path>] [--hold <seconds>]
                      [--recovery-choice return|retry|quit] [--capture-dir <dir>]

Environment: STELLA_LAUNCHER_ROOT (install root, for testing),
STELLA_LAUNCHER_KEY_FILE (0600 PEM instead of the keychain),
STELLA_LAUNCHER_BACKEND_URL, STELLA_LAUNCHER_STABLE_SECONDS,
STELLA_LAUNCHER_READY_TIMEOUT_SECONDS.
"""

func parseOptions() -> Options {
    var options = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    func value(_ flag: String) -> String {
        guard !args.isEmpty else {
            FileHandle.standardError.write(Data("\(flag) needs a value\n\(usage)\n".utf8))
            exit(64)
        }
        return args.removeFirst()
    }
    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--self-test": options.selfTest = true
        case "--source": options.source = value(arg)
        case "--source-ref": options.sourceRef = value(arg)
        case "--backend": options.backend = value(arg)
        case "--bun": options.localBun = value(arg)
        case "--hold": options.hold = TimeInterval(value(arg)) ?? 0
        case "--capture-dir": options.captureDir = URL(fileURLWithPath: value(arg))
        case "--recovery-choice":
            guard let choice = RecoveryChoice(rawValue: value(arg)) else {
                FileHandle.standardError.write(Data("unknown recovery choice\n".utf8))
                exit(64)
            }
            options.recoveryChoice = choice
        case "-h", "--help":
            print(usage)
            exit(0)
        default:
            // Finder adds -psn_… on older systems; ignore anything unknown.
            if !arg.hasPrefix("-psn") { log("launcher: ignoring argument \(arg)") }
        }
    }
    return options
}

let paths = LauncherPaths.resolve()
try? FileManager.default.createDirectory(at: paths.logs, withIntermediateDirectories: true)
Logger.shared = Logger(url: paths.launcherLog)
let options = parseOptions()

// One launcher per install root.
let lockFd = open(paths.lockFile.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
if lockFd < 0 || flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    log("launcher: another launcher owns \(paths.root.path); exiting")
    exit(options.selfTest ? 1 : 0)
}

let launcher = Launcher(options: options, paths: paths)

// Forward termination to Electron, then go.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        log("launcher: signal \(sig); stopping Stella")
        launcher.current?.terminate()
        exit(128 + sig)
    }
    source.resume()
    signalSources.append(source)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Thread.detachNewThread {
            let code = launcher.run()
            log("launcher: exit \(code)")
            exit(code)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
