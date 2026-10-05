import AppKit
import WebKit

/// What launcher/common/launcher.html shows: its render() state.
struct LauncherViewState {
    enum Phase: String {
        case idle, starting, running, stopping, failed
    }

    var phase = Phase.idle
    /// starting/stopping: what is happening now, in plain words.
    var status = ""
    /// starting: the part of setup that is done (0...1), and where the
    /// current step ends; the page's bar eases between them.
    var progress = 0.0
    var progressTo = 0.0
    /// failed: one sentence.
    var reason = ""
    /// failed: Electron's last lines (Settings > Last error).
    var output: [String] = []
    var hasKnownGood = false
    /// Short HEAD, "" before install.
    var version = ""

    var json: [String: Any] {
        ["platform": "macos", "phase": phase.rawValue, "status": status, "reason": reason,
         "progress": phase == .starting ? progress : 0, "progressTo": phase == .starting ? progressTo : 0,
         "output": output, "hasKnownGood": hasKnownGood, "version": version]
    }
}

/// What the user chose while the launcher waits (idle or failed).
enum LauncherCommand {
    case start
    case returnToKnownGood
    case reinstall
    case close
}

/// The launcher's one window: the shared launcher page in a WKWebView. Home
/// with Start, the progress of a start, "Stella is running" with Shut down,
/// "Stella couldn't start" with Try again, and Settings. Every method may be
/// called from any thread; work hops to the main thread, which owns the state.
final class LauncherWindow: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    enum Show {
        case keep
        /// Bring the window front only if it is hidden.
        case reveal
        case front
        case hide
    }

    /// Main thread: the user's choice in idle or failed.
    var onCommand: ((LauncherCommand) -> Void)?
    /// Main thread: the user asked a running Stella to quit.
    var onShutdown: (() -> Void)?

    private static let size = NSSize(width: 380, height: 460)
    private let logs: URL
    private let captureDir: URL?
    private var state = LauncherViewState()
    private var built = false
    private var window: NSWindow?
    private var webView: WKWebView?
    /// The page posted `loaded`: renders reach it and the window may show.
    private var loaded = false
    private var wantsVisible = false
    private var afterLoad: [() -> Void] = []
    private var capturedStarting = false
    private let captures = DispatchGroup()

    init(logs: URL, captureDir: URL?) {
        self.logs = logs
        self.captureDir = captureDir
    }

    /// Change the state, render it and show or hide the window.
    func update(show: Show = .keep, _ change: @escaping (inout LauncherViewState) -> Void) {
        DispatchQueue.main.async { [self] in
            change(&state)
            apply(show)
        }
    }

    /// Self-test: act as if the page posted `action` after `delay` seconds.
    func perform(_ action: String, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
            log("ui: self-test presses \(action)")
            handle(action)
        }
    }

    /// Save a PNG of the page as `name` in the capture directory, `delay`
    /// seconds after it has loaded, then run `then` on the main thread.
    func capture(_ name: String, after delay: TimeInterval, then: (() -> Void)? = nil) {
        guard let captureDir else {
            if let then { DispatchQueue.main.async(execute: then) }
            return
        }
        captures.enter()
        DispatchQueue.main.async { [self] in
            whenLoaded { [self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
                    snapshot(to: captureDir.appendingPathComponent(name)) { [self] in
                        captures.leave()
                        then?()
                    }
                }
            }
        }
    }

    /// Self-test after `ready`: front as a reopen would show it, then Settings.
    func captureRunning() {
        captures.enter()
        update(show: .front) { _ in }
        capture("running.png", after: 1) { [self] in
            evaluate("window.stellaLauncher.showSettings(true)")
            capture("settings.png", after: 0.5) { [self] in
                evaluate("window.stellaLauncher.showSettings(false)")
                hideWindow()
                captures.leave()
            }
        }
    }

    /// Blocks (off the main thread) until pending captures are written.
    func waitForCaptures() {
        _ = captures.wait(timeout: .now() + 15)
    }

    /// Close Window and Quit, which an accessory app only gets from its own menu.
    func installMenu() {
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Close Window", action: #selector(closeFromMenu(_:)), keyEquivalent: "w").target = self
        appMenu.addItem(withTitle: "Quit Stella", action: #selector(closeFromMenu(_:)), keyEquivalent: "q").target = self
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let menu = NSMenu()
        for submenu in [appMenu, editMenu] {
            let item = NSMenuItem()
            item.submenu = submenu
            menu.addItem(item)
        }
        NSApp.mainMenu = menu
    }

    // MARK: Main thread

    private func apply(_ show: Show) {
        if !built { build() }
        guard let window else {
            withoutPage()
            return
        }
        render()
        switch show {
        case .keep: break
        case .reveal: if !wantsVisible || !window.isVisible { present() }
        case .front: present()
        case .hide: hideWindow()
        }
        if captureDir != nil, !capturedStarting, state.phase == .starting, wantsVisible {
            capturedStarting = true
            capture("starting.png", after: 0.5)
        }
    }

    private func build() {
        built = true
        guard let url = Bundle.main.url(forResource: "launcher", withExtension: "html"),
              let html = try? String(contentsOf: url, encoding: .utf8)
        else {
            log("ui: launcher.html is missing from the app bundle; running without a window")
            return
        }
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Stella"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.delegate = self
        // The page's own background, so nothing flashes before its first frame.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == NSAppearance.Name.darkAqua
                ? NSColor(srgbRed: 0x0F / 255, green: 0x0F / 255, blue: 0x0D / 255, alpha: 1)
                : NSColor(srgbRed: 0xFD / 255, green: 0xFD / 255, blue: 0xFB / 255, alpha: 1)
        }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "stella")
        let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.size), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        // Full size: the traffic lights float over the page's empty top 28px.
        window.contentView = webView
        webView.loadHTMLString(html, baseURL: nil)
        window.center()
        self.window = window
        self.webView = webView
    }

    private func present() {
        guard let window else { return }
        wantsVisible = true
        guard loaded else {
            // It shows on `loaded`, once the page can paint its real first
            // frame. A cold WebContent process can take a few seconds; the
            // timeout only covers a page that never reports.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [self] in
                if !loaded {
                    log("ui: the page did not report loaded in time; showing it anyway")
                    pageLoaded()
                }
            }
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func hideWindow() {
        wantsVisible = false
        window?.orderOut(nil)
    }

    private func pageLoaded() {
        let first = !loaded
        loaded = true
        render()
        guard first else { return }
        if wantsVisible { present() }
        let pending = afterLoad
        afterLoad = []
        pending.forEach { $0() }
    }

    private func whenLoaded(_ work: @escaping () -> Void) {
        if !built { build() }
        if loaded || webView == nil { work() } else { afterLoad.append(work) }
    }

    /// Native -> page: the full state, every time.
    private func render() {
        guard loaded,
              let data = try? JSONSerialization.data(withJSONObject: state.json),
              let json = String(data: data, encoding: .utf8)
        else { return }
        evaluate("window.stellaLauncher.render(\(json))")
    }

    private func evaluate(_ script: String) {
        webView?.evaluateJavaScript("\(script); true") { _, error in
            if let error { log("ui: script failed: \(error)") }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let action = object["action"] as? String
        else {
            log("ui: ignored page message \(message.body)")
            return
        }
        handle(action)
    }

    /// Page -> native. Choices only count in the phase that offers them.
    private func handle(_ action: String) {
        let waiting = state.phase == .idle || state.phase == .failed
        switch action {
        case "loaded":
            log("ui: page loaded")
            pageLoaded()
        case "start" where waiting:
            choose(.start, "Starting Stella…", to: 0.05)
        case "return" where waiting:
            choose(.returnToKnownGood, "Restoring the last working version…", to: 0.3)
        case "reinstall" where waiting:
            choose(.reinstall, "Reinstalling Stella…", to: 0.1)
        case "shutdown" where state.phase == .running:
            log("ui: shut down")
            state.phase = .stopping
            state.status = "Shutting down…"
            render()
            onShutdown?()
        case "openLogs":
            NSWorkspace.shared.open(logs)
        case "close":
            close()
        default:
            log("ui: ignored \(action) while \(state.phase.rawValue)")
        }
    }

    private func choose(_ command: LauncherCommand, _ status: String, to: Double) {
        log("ui: \(command)")
        state.phase = .starting
        state.status = status
        state.progress = 0
        state.progressTo = to
        apply(.keep)
        onCommand?(command)
    }

    /// The close button, Cmd+W and Cmd+Q: quit while nothing runs, otherwise
    /// just hide (Stella keeps running).
    private func close() {
        hideWindow()
        if state.phase == .idle || state.phase == .failed {
            log("ui: closed")
            onCommand?(.close)
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }

    @objc private func closeFromMenu(_ sender: Any?) {
        close()
    }

    /// No page in the bundle: start right away, and ask about failures in an alert.
    private func withoutPage() {
        switch state.phase {
        case .idle:
            state.phase = .starting
            onCommand?(.start)
        case .failed:
            DispatchQueue.main.async { [self] in
                guard state.phase == .failed else { return }
                let alert = NSAlert()
                alert.messageText = "Stella couldn't start"
                alert.informativeText = state.reason
                alert.addButton(withTitle: "Try again")
                alert.addButton(withTitle: "Quit")
                NSApp.activate(ignoringOtherApps: true)
                let retry = alert.runModal() == .alertFirstButtonReturn
                state.phase = retry ? .starting : .idle
                onCommand?(retry ? .start : .close)
            }
        default:
            break
        }
    }

    /// WKWebView content isn't in cacheDisplay, so the page comes from
    /// takeSnapshot, with the title bar's traffic lights drawn over it.
    private func snapshot(to url: URL, done: @escaping () -> Void) {
        guard let webView else {
            done()
            return
        }
        webView.takeSnapshot(with: nil) { [self] image, error in
            defer { done() }
            guard let image, let page = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let rep = NSBitmapImageRep(
                      bitmapDataPlanes: nil, pixelsWide: page.width, pixelsHigh: page.height,
                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
            else {
                log("ui: capture \(url.lastPathComponent) failed: \(error.map { "\($0)" } ?? "no image")")
                return
            }
            rep.size = webView.bounds.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            window?.backgroundColor.setFill()
            NSRect(origin: .zero, size: rep.size).fill()
            image.draw(in: NSRect(origin: .zero, size: rep.size))
            for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                guard let button = window?.standardWindowButton(kind),
                      let buttonRep = button.bitmapImageRepForCachingDisplay(in: button.bounds)
                else { continue }
                button.cacheDisplay(in: button.bounds, to: buttonRep)
                buttonRep.draw(in: button.convert(button.bounds, to: nil))
            }
            NSGraphicsContext.restoreGraphicsState()
            guard let png = rep.representation(using: .png, properties: [:]) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try png.write(to: url)
                log("ui: captured \(url.path)")
            } catch {
                log("ui: capture \(url.lastPathComponent) failed: \(error)")
            }
        }
    }
}
