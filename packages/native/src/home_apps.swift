import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct ListedAppPayload: Codable {
    let name: String
    let bundleId: String?
    let pid: Int32
    let isActive: Bool
    let windowTitle: String

    let iconDataUrl: String?
}

struct ListAppsPayload: Codable {
    let ok: Bool
    let apps: [ListedAppPayload]
    let warnings: [String]
}

func emitJson<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"apps\":[],\"warnings\":[\"encode failed\"]}")
    }
}

func encodeAppIconAsBase64(_ icon: NSImage?) -> String? {
    guard let icon, icon.size.width > 0, icon.size.height > 0 else { return nil }

    let targetSize = CGSize(width: 32, height: 32)
    var proposedRect = NSRect(origin: .zero, size: targetSize)
    guard let sourceCGImage = icon.cgImage(
        forProposedRect: &proposedRect,
        context: nil,
        hints: nil
    ) else {
        return nil
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    guard let context = CGContext(
        data: nil,
        width: Int(targetSize.width),
        height: Int(targetSize.height),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo.rawValue
    ) else {
        return nil
    }
    context.interpolationQuality = .high
    context.draw(sourceCGImage, in: CGRect(origin: .zero, size: targetSize))

    guard let resizedCGImage = context.makeImage() else { return nil }

    let bitmap = NSBitmapImageRep(cgImage: resizedCGImage)
    guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
        return nil
    }
    let base64 = pngData.base64EncodedString()
    return "data:image/png;base64,\(base64)"
}

func axAttributeValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard status == .success else { return nil }
    return value
}

func axStringValue(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let raw = axAttributeValue(element, attribute) else { return nil }
    if let s = raw as? String {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    return nil
}

func axElementValue(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let raw = axAttributeValue(element, attribute) else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func axElementArrayValue(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    guard let raw = axAttributeValue(element, attribute) else { return [] }
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let array = unsafeBitCast(raw, to: CFArray.self)
    let count = CFArrayGetCount(array)
    var results: [AXUIElement] = []
    results.reserveCapacity(count)
    for index in 0..<count {
        let pointer = CFArrayGetValueAtIndex(array, index)
        results.append(unsafeBitCast(pointer, to: AXUIElement.self))
    }
    return results
}

struct TitleCollectionResult {
    let titles: [Int32: String]
    let cgFilledCount: Int
    let needsAxCount: Int
    let axTrusted: Bool
    let axFilledCount: Int
}

func collectTopWindowTitlesByPid(targetPids: Set<Int32>) -> TitleCollectionResult {
    var titles: [Int32: String] = [:]

    if let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] {
        for window in windowList {
            guard let pid32 = (window[kCGWindowOwnerPID as String] as? Int).map(Int32.init) else {
                continue
            }
            if !targetPids.contains(pid32) { continue }
            if titles[pid32] != nil { continue }

            if let layer = window[kCGWindowLayer as String] as? Int, layer > 0 { continue }
            let rawTitle = (window[kCGWindowName as String] as? String) ?? ""
            let trimmed = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            titles[pid32] = trimmed
        }
    }

    let cgFilledCount = titles.count

    let needsAxLookup = targetPids.subtracting(titles.keys)
    let axTrusted = AXIsProcessTrusted()
    var axFilledCount = 0
    if !needsAxLookup.isEmpty, axTrusted {
        for pid in needsAxLookup {
            let axApp = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(axApp, 0.25)
            let candidate =
                axElementValue(axApp, kAXFocusedWindowAttribute as String)
                ?? axElementArrayValue(axApp, kAXWindowsAttribute as String).first
            guard let candidate else { continue }
            AXUIElementSetMessagingTimeout(candidate, 0.25)
            if let title = axStringValue(candidate, kAXTitleAttribute as String),
               !title.isEmpty {
                titles[pid] = title
                axFilledCount += 1
            }
        }
    }

    return TitleCollectionResult(
        titles: titles,
        cgFilledCount: cgFilledCount,
        needsAxCount: needsAxLookup.count,
        axTrusted: axTrusted,
        axFilledCount: axFilledCount
    )
}

func mruRankByPid() -> [Int32: Int] {
    var rank: [Int32: Int] = [:]
    var nextRank = 0
    guard let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return rank
    }
    for window in windowList {
        guard let pid32 = (window[kCGWindowOwnerPID as String] as? Int).map(Int32.init) else {
            continue
        }
        if let layer = window[kCGWindowLayer as String] as? Int, layer != 0 { continue }
        if rank[pid32] != nil { continue }
        rank[pid32] = nextRank
        nextRank += 1
    }
    return rank
}

func activationPolicyRank(_ policy: NSApplication.ActivationPolicy) -> Int {
    switch policy {
    case .regular:
        return 0
    case .accessory:
        return 1
    case .prohibited:
        return 2
    @unknown default:
        return 3
    }
}

func normalized(_ s: String?) -> String {
    return (s ?? "").lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
}

func runListCommand() {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let runningApps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited && $0.processIdentifier > 0 }

    let targetPids = Set(
        runningApps
            .filter { $0.activationPolicy == .regular }
            .map { $0.processIdentifier }
    )
    let collected = collectTopWindowTitlesByPid(targetPids: targetPids)
    let titlesByPid = collected.titles
    let mruRank = mruRankByPid()
    let unrankedSentinel = Int.max

    let sorted = runningApps
        .sorted { lhs, rhs in

            let lhsRank = mruRank[lhs.processIdentifier] ?? unrankedSentinel
            let rhsRank = mruRank[rhs.processIdentifier] ?? unrankedSentinel
            if lhsRank != rhsRank { return lhsRank < rhsRank }

            let lhsPolicyRank = activationPolicyRank(lhs.activationPolicy)
            let rhsPolicyRank = activationPolicyRank(rhs.activationPolicy)
            if lhsPolicyRank != rhsPolicyRank {
                return lhsPolicyRank < rhsPolicyRank
            }

            let lhsName = normalized(lhs.localizedName ?? lhs.bundleIdentifier)
            let rhsName = normalized(rhs.localizedName ?? rhs.bundleIdentifier)
            if lhsName != rhsName {
                return lhsName < rhsName
            }
            return lhs.processIdentifier < rhs.processIdentifier
        }

    let iconBudget = 12
    let apps = sorted.enumerated().map { (index, app) -> ListedAppPayload in
        let iconDataUrl = index < iconBudget ? encodeAppIconAsBase64(app.icon) : nil
        return ListedAppPayload(
            name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
            bundleId: app.bundleIdentifier,
            pid: app.processIdentifier,
            isActive: app.processIdentifier == frontmostPid,
            windowTitle: titlesByPid[app.processIdentifier] ?? "",
            iconDataUrl: iconDataUrl
        )
    }

    let diagnostics = [
        "titles: cg=\(collected.cgFilledCount) ax=\(collected.axFilledCount) needsAx=\(collected.needsAxCount) axTrusted=\(collected.axTrusted)",
    ]
    emitJson(ListAppsPayload(ok: true, apps: apps, warnings: diagnostics))
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "list"

switch command {
case "list":
    runListCommand()
default:
    fputs("Usage: home_apps list\n", stderr)
    exit(1)
}
