import AppKit
import QuartzCore

/// An update that restarts Stella, held on screen between processes (see
/// UpdateTransition in packages/desktop/electron). Electron frosts its
/// window, sends `{"op":"hold"}` with the frosted picture, and exits; the
/// launcher shows the same picture with the mark and a shimmering "Updating
/// Stella" until the next Electron window is ready over it, so the window
/// never blinks out.
struct UpdateHold {
    let image: URL
    let mark: URL?
    let label: String
    /// Electron's content bounds: points, origin at the primary display's top left.
    let frame: NSRect
    let since: Date
    let dark: Bool

    init?(_ message: [String: Any]) {
        guard let image = message["image"] as? String,
              let frame = message["frame"] as? [String: Any],
              let x = (frame["x"] as? NSNumber)?.doubleValue,
              let y = (frame["y"] as? NSNumber)?.doubleValue,
              let width = (frame["width"] as? NSNumber)?.doubleValue,
              let height = (frame["height"] as? NSNumber)?.doubleValue,
              width > 0, height > 0
        else { return nil }
        self.image = URL(fileURLWithPath: image)
        mark = (message["mark"] as? String).map { URL(fileURLWithPath: $0) }
        label = (message["label"] as? String) ?? "Updating Stella"
        self.frame = NSRect(x: x, y: y, width: width, height: height)
        let since = (message["since"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
        self.since = Date(timeIntervalSince1970: since / 1000)
        dark = (message["dark"] as? Bool) ?? false
    }
}

final class HoldWindow {
    /// The mark and label wait this long after the update started, so a
    /// quick restart never shows them (matches Electron's hold).
    private static let labelDelay: TimeInterval = 0.7
    private var window: NSWindow?
    /// Bumped on every show and hide, so a delayed hide never takes down a
    /// later hold.
    private var generation = 0

    func show(_ hold: UpdateHold, giveUpAfter limit: TimeInterval) {
        DispatchQueue.main.async { [self] in
            generation += 1
            let current = generation
            close()
            guard let picture = NSImage(contentsOf: hold.image),
                  let primary = NSScreen.screens.first
            else { return }
            let rect = NSRect(
                x: hold.frame.minX,
                y: primary.frame.maxY - hold.frame.maxY,
                width: hold.frame.width,
                height: hold.frame.height)
            let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = true
            window.isReleasedWhenClosed = false
            // Clicks go to whatever is underneath: the hold never traps the user.
            window.ignoresMouseEvents = true
            window.contentView = content(for: hold, picture: picture, size: rect.size)
            window.orderFrontRegardless()
            self.window = window
            DispatchQueue.main.asyncAfter(deadline: .now() + limit) { [self] in
                if generation == current { close() }
            }
        }
    }

    func hide(after delay: TimeInterval) {
        DispatchQueue.main.async { [self] in
            let current = generation
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
                if generation == current { close() }
            }
        }
    }

    private func close() {
        window?.orderOut(nil)
        window = nil
    }

    private func content(for hold: UpdateHold, picture: NSImage, size: NSSize) -> NSView {
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.layer?.cornerRadius = 10
        root.layer?.masksToBounds = true

        let image = NSImageView(frame: root.bounds)
        image.image = picture
        image.imageScaling = .scaleAxesIndependently
        image.autoresizingMask = [.width, .height]
        root.addSubview(image)

        let foreground = hold.dark
            ? NSColor(srgbRed: 0.961, green: 0.961, blue: 0.969, alpha: 1)
            : NSColor(srgbRed: 0.114, green: 0.114, blue: 0.122, alpha: 1)
        let label = NSTextField(labelWithString: hold.label)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = foreground
        label.sizeToFit()

        let markSize: CGFloat = 34
        let gap: CGFloat = 12
        let width = max(markSize, label.frame.width)
        let height = markSize + gap + label.frame.height
        let group = NSView(frame: NSRect(
            x: (size.width - width) / 2,
            y: (size.height - height) / 2,
            width: width,
            height: height))
        group.wantsLayer = true
        group.alphaValue = 0
        if let markURL = hold.mark, let markImage = NSImage(contentsOf: markURL) {
            let mark = NSImageView(frame: NSRect(x: (width - markSize) / 2, y: height - markSize, width: markSize, height: markSize))
            mark.image = markImage
            mark.imageScaling = .scaleProportionallyUpOrDown
            group.addSubview(mark)
        }
        let shimmer = NSView(frame: NSRect(x: (width - label.frame.width) / 2, y: 0, width: label.frame.width, height: label.frame.height))
        shimmer.wantsLayer = true
        label.frame.origin = .zero
        shimmer.addSubview(label)
        shimmer.layer?.mask = shimmerMask(bounds: shimmer.bounds)
        group.addSubview(shimmer)
        root.addSubview(group)

        // One moving thing: light passes through the label; the mark stays still.
        let delay = max(0, hold.since.addingTimeInterval(Self.labelDelay).timeIntervalSinceNow)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.35
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
                group.animator().alphaValue = 1
            }
        }
        return root
    }

    /// The label at 45% with a bright band sweeping through it, like the CSS shimmer.
    private func shimmerMask(bounds: CGRect) -> CAGradientLayer {
        let mask = CAGradientLayer()
        mask.frame = bounds
        mask.startPoint = CGPoint(x: 0, y: 0.5)
        mask.endPoint = CGPoint(x: 1, y: 0.5)
        let dim = NSColor(white: 1, alpha: 0.45).cgColor
        mask.colors = [dim, NSColor.white.cgColor, dim]
        mask.locations = [-0.3, -0.15, 0]
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [-0.3, -0.15, 0]
        sweep.toValue = [1, 1.15, 1.3]
        sweep.duration = 1.8
        sweep.repeatCount = .infinity
        mask.add(sweep, forKey: "shimmer")
        return mask
    }
}
