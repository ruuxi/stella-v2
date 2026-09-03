import ExpoModulesCore
import UIKit

// The sidebar's tab bar is the system segmented control (a SwiftUI segmented
// Picker hosted through @expo/ui) because only the real control carries
// Apple's Liquid Glass selection lens. Its colours, though, come from UIKit's
// own fills and cannot be reached from SwiftUI modifiers, so this module sets
// them through the UIAppearance proxy. Values apply to controls created after
// the call; the caller re-creates its picker when the theme changes.
public final class StellaSegmentedAppearanceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellaSegmentedAppearance")

    // Both colours are "#RRGGBB" or "#RRGGBBAA"; nil restores the default.
    // Synchronous from JS so the call precedes the commit that creates the
    // picker; the appearance itself is set on the main queue, which is also
    // where React Native mounts the native views, so ordering is preserved.
    Function("apply") { (background: String?, selected: String?) in
      let backgroundColor = background.flatMap(Self.color(fromHex:))
      let selectedColor = selected.flatMap(Self.color(fromHex:))
      DispatchQueue.main.async {
        let proxy = UISegmentedControl.appearance()
        proxy.backgroundColor = backgroundColor
        proxy.selectedSegmentTintColor = selectedColor
      }
    }
  }

  private static func color(fromHex hex: String) -> UIColor? {
    var digits = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if digits.hasPrefix("#") { digits.removeFirst() }
    guard digits.count == 6 || digits.count == 8,
          let value = UInt64(digits, radix: 16) else { return nil }
    let hasAlpha = digits.count == 8
    let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
    let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
    let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
    let a = hasAlpha ? CGFloat(value & 0xff) / 255 : 1
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}
