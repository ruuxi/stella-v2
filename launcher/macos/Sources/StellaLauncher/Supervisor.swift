import Darwin
import Foundation

/// A thread-safe FIFO the supervisor blocks on.
final class EventQueue<T> {
    private var items: [T] = []
    private let condition = NSCondition()

    func post(_ item: T) {
        condition.lock()
        items.append(item)
        condition.signal()
        condition.unlock()
    }

    /// Next event, or nil once `deadline` passes.
    func next(until deadline: Date?) -> T? {
        condition.lock()
        defer { condition.unlock() }
        while items.isEmpty {
            if let deadline {
                if !condition.wait(until: deadline) && items.isEmpty { return nil }
            } else {
                condition.wait()
            }
        }
        return items.removeFirst()
    }
}

/// Keeps the last lines Electron wrote to stdout/stderr for the recovery
/// screen, and tees everything to logs/electron.log.
final class OutputCapture {
    private let lock = NSLock()
    private var lines: [String] = []
    private var partial = ""
    private let limit: Int
    private let file: FileHandle?

    init(logFile: URL, limit: Int = 40) {
        self.limit = limit
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        file = try? FileHandle(forWritingTo: logFile)
        _ = try? file?.seekToEnd()
    }

    func append(_ data: Data) {
        try? file?.write(contentsOf: data)
        lock.lock()
        defer { lock.unlock() }
        partial += String(decoding: data, as: UTF8.self)
        var parts = partial.components(separatedBy: "\n")
        partial = parts.removeLast()
        lines.append(contentsOf: parts)
        if lines.count > limit { lines.removeFirst(lines.count - limit) }
    }

    var lastLines: [String] {
        lock.lock()
        defer { lock.unlock() }
        let all = partial.isEmpty ? lines : lines + [partial]
        return Array(all.suffix(limit))
    }

    func close() { try? file?.close() }
}

/// One Electron process: spawned with responsibility disclaimed (so Stella.app,
/// not the launcher, owns its TCC prompts), fd 3 a socketpair for the
/// launcher channel, stdout/stderr captured.
final class ElectronProcess {
    enum Event {
        case message([String: Any])
        case exited(code: Int32, signal: Int32)
        case timer(String)
    }

    let pid: pid_t
    let events = EventQueue<Event>()
    let output: OutputCapture
    private let channelFd: Int32
    private let writeLock = NSLock()
    private let reapLock = NSLock()
    private var reaped = false

    init(executable: URL, args: [String], cwd: URL, env: [String: String], logFile: URL) throws {
        output = OutputCapture(logFile: logFile)
        output.append(Data("\n===== launch \(Date()) =====\n".utf8))

        var pair: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            throw LauncherError("socketpair failed: \(String(cString: strerror(errno)))")
        }
        var pipeFds: [Int32] = [0, 0]
        guard pipe(&pipeFds) == 0 else { throw LauncherError("pipe failed") }
        // Keep the child's end above 3 so dup2 onto 3 is never a no-op.
        let childChannel = fcntl(pair[1], F_DUPFD_CLOEXEC, 10)
        close(pair[1])
        channelFd = pair[0]
        _ = fcntl(channelFd, F_SETFD, FD_CLOEXEC)
        _ = fcntl(pipeFds[0], F_SETFD, FD_CLOEXEC)
        var nosig: Int32 = 1
        setsockopt(channelFd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, pipeFds[1], 1)
        posix_spawn_file_actions_adddup2(&actions, pipeFds[1], 2)
        posix_spawn_file_actions_adddup2(&actions, childChannel, 3)
        posix_spawn_file_actions_addchdir_np(&actions, cwd.path)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        var noSignals = sigset_t()
        sigemptyset(&noSignals)
        posix_spawnattr_setsigmask(&attr, &noSignals)
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        posix_spawnattr_setsigdefault(&attr, &allSignals)
        // CLOEXEC_DEFAULT: the child gets exactly 0-3, nothing else of ours.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
        ElectronProcess.disclaimResponsibility(&attr)

        let argv = ([executable.path] + args).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var child: pid_t = 0
        let status = posix_spawn(&child, executable.path, &actions, &attr, argv, envp)
        close(pipeFds[1])
        close(childChannel)
        guard status == 0 else {
            close(pipeFds[0])
            close(channelFd)
            throw LauncherError("posix_spawn \(executable.path): \(String(cString: strerror(status)))")
        }
        pid = child
        log("supervisor: spawned Electron pid \(child)")

        let readFd = pipeFds[0]
        let output = self.output
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 16384)
            while true {
                let count = read(readFd, &buffer, buffer.count)
                if count <= 0 { break }
                output.append(Data(buffer[0..<count]))
            }
            close(readFd)
        }

        let events = self.events
        let fd = channelFd
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 8192)
            var pending = Data()
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count <= 0 { break }
                pending.append(contentsOf: buffer[0..<count])
                while let newline = pending.firstIndex(of: 0x0A) {
                    let line = pending[pending.startIndex..<newline]
                    pending.removeSubrange(pending.startIndex...newline)
                    if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                        events.post(.message(object))
                    } else {
                        log("channel: ignored malformed line \(String(decoding: line, as: UTF8.self).prefix(200))")
                    }
                }
            }
        }

        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            while waitpid(child, &status, 0) == -1 && errno == EINTR {}
            self?.markReaped()
            let exitCode = (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
            let signal = (status & 0x7f) != 0 ? status & 0x7f : 0
            events.post(.exited(code: exitCode, signal: signal))
        }
    }

    /// Port of packages/desktop/scripts/disclaim-spawn.c.
    private static func disclaimResponsibility(_ attr: inout posix_spawnattr_t?) {
        typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
            log("supervisor: responsibility_spawnattrs_setdisclaim unavailable")
            return
        }
        let disclaim = unsafeBitCast(symbol, to: Disclaim.self)
        _ = disclaim(&attr, 1)
    }

    func send(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(channelFd, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
    }

    func after(_ seconds: TimeInterval, _ name: String) {
        let events = self.events
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { events.post(.timer(name)) }
    }

    private func markReaped() {
        reapLock.lock()
        reaped = true
        reapLock.unlock()
    }

    /// Signal the child unless it has already been reaped (its pid could be reused).
    private func signal(_ signal: Int32) {
        reapLock.lock()
        defer { reapLock.unlock() }
        if !reaped { kill(pid, signal) }
    }

    func terminate() {
        signal(SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [weak self] in self?.signal(SIGKILL) }
    }

    func closeChannel() {
        close(channelFd)
        output.close()
    }
}
