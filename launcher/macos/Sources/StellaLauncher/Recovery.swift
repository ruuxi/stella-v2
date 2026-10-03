import AppKit
import Foundation

enum RecoveryChoice: String {
    case returnToKnownGood = "return"
    case reinstall
    case retry
    case quit
}

/// Saves a PNG of one of the launcher's own windows (no Screen Recording
/// permission needed, since it draws the view hierarchy itself).
func captureWindow(_ window: NSWindow, to url: URL) {
    guard let view = window.contentView?.superview ?? window.contentView,
          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
    else { return }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? png.write(to: url)
    log("ui: captured \(url.path)")
}

/// The install/prepare progress panel. Every method may be called from any
/// thread; work hops to the main thread.
final class ProgressWindow {
    private var window: NSWindow?
    private var label: NSTextField?
    private var captured = false
    private let captureDir: URL?

    init(captureDir: URL?) { self.captureDir = captureDir }

    func show(_ status: String) {
        DispatchQueue.main.async { [self] in
            if window == nil { build() }
            label?.stringValue = status
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if let captureDir, !captured {
                captured = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                    if let window { captureWindow(window, to: captureDir.appendingPathComponent("progress.png")) }
                }
            }
        }
    }

    func hide() {
        DispatchQueue.main.async { [self] in
            window?.orderOut(nil)
        }
    }

    private func build() {
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 120),
            styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "Stella"
        panel.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "Getting Stella ready")
        title.font = .boldSystemFont(ofSize: 14)
        let status = NSTextField(labelWithString: "")
        status.textColor = .secondaryLabelColor
        let spinner = NSProgressIndicator()
        spinner.style = .bar
        spinner.isIndeterminate = true
        spinner.startAnimation(nil)
        let stack = NSStackView(views: [title, status, spinner])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = NSView()
        panel.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
            stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
            spinner.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
        ])
        panel.center()
        window = panel
        label = status
    }
}

/// "Stella couldn't start": the reason, the last 40 lines Electron wrote, and
/// Return to last working / Try again / Quit. Blocks the calling (supervisor)
/// thread until a choice is made.
final class RecoveryWindow: NSObject {
    private var window: NSWindow?
    private var choice: RecoveryChoice = .quit
    private let done = DispatchSemaphore(value: 0)
    private var buttons: [RecoveryChoice: NSButton] = [:]

    struct Automation {
        /// Click this button after `delay` seconds (self-test).
        let choice: RecoveryChoice
        let delay: TimeInterval
    }

    func present(
        reason: String,
        output: [String],
        hasKnownGood: Bool,
        captureTo: URL?,
        automation: Automation?
    ) -> RecoveryChoice {
        DispatchQueue.main.async { [self] in
            build(reason: reason, output: output, hasKnownGood: hasKnownGood)
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            log("recovery: shown (window \(window?.windowNumber ?? 0)) reason: \(reason)")
            if let captureTo {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                    if let window { captureWindow(window, to: captureTo) }
                }
            }
            if let automation {
                DispatchQueue.main.asyncAfter(deadline: .now() + automation.delay) { [self] in
                    // "return" means the primary button, which reads
                    // "Reinstall" when there is no known-good version yet.
                    let target = buttons[automation.choice]
                        ?? (automation.choice == .returnToKnownGood ? buttons[.reinstall] : nil)
                    log("recovery: self-test clicks \(automation.choice.rawValue)")
                    if let target { target.performClick(nil) } else { finish(automation.choice) }
                }
            }
        }
        done.wait()
        log("recovery: chose \(choice.rawValue)")
        return choice
    }

    private func build(reason: String, output: [String], hasKnownGood: Bool) {
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 460),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        panel.title = "Stella"
        panel.isReleasedWhenClosed = false

        let title = NSTextField(labelWithString: "Stella couldn't start")
        title.font = .boldSystemFont(ofSize: 16)
        let message = NSTextField(wrappingLabelWithString: reason)
        message.textColor = .secondaryLabelColor

        let scroll = NSTextView.scrollableTextView()
        let text = scroll.documentView as! NSTextView
        text.isEditable = false
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        text.string = output.isEmpty ? "(Stella wrote no output.)" : output.joined(separator: "\n")
        text.scrollToEndOfDocument(nil)
        scroll.borderType = .bezelBorder

        let primary = hasKnownGood ? RecoveryChoice.returnToKnownGood : RecoveryChoice.reinstall
        let primaryButton = button(hasKnownGood ? "Return to last working version" : "Reinstall", primary)
        primaryButton.keyEquivalent = "\r"
        let retry = button("Try again", .retry)
        let quit = button("Quit", .quit)
        let row = NSStackView(views: [quit, NSView(), retry, primaryButton])
        row.orientation = .horizontal
        row.spacing = 8

        let stack = NSStackView(views: [title, message, scroll, row])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        panel.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 260),
        ])
        panel.center()
        window = panel
    }

    private func button(_ title: String, _ choice: RecoveryChoice) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(clicked(_:)))
        button.bezelStyle = .rounded
        button.identifier = NSUserInterfaceItemIdentifier(choice.rawValue)
        buttons[choice] = button
        return button
    }

    @objc private func clicked(_ sender: NSButton) {
        finish(RecoveryChoice(rawValue: sender.identifier?.rawValue ?? "") ?? .quit)
    }

    private func finish(_ choice: RecoveryChoice) {
        self.choice = choice
        window?.orderOut(nil)
        done.signal()
    }
}
