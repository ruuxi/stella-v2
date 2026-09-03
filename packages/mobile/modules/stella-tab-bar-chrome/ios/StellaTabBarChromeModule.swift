import ExpoModulesCore
import UIKit

// The sidebar's tab bar is the system tab bar, hosted as a SwiftUI TabView
// with empty pages. Two things about it cannot be reached from SwiftUI or
// from UIAppearance, because UIKit sets them explicitly on private views
// after creation: the tab controller's layout container and the page's
// hosting view both paint the system background behind the floating bar,
// and the tab titles are private labels with a fixed system font. This
// walks the hosted subtree and sets them directly. Called after the host
// lays out, and again after a selection change re-creates the labels.
public final class StellaTabBarChromeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellaTabBarChrome")

    Function("apply") { (viewTag: Int, titleFontFamily: String?, titleSize: Double) in
      DispatchQueue.main.async {
        guard let root = self.appContext?.findView(withTag: viewTag, ofType: UIView.self) else {
          return
        }
        let font = titleFontFamily.flatMap { UIFont(name: $0, size: CGFloat(titleSize)) }
        Self.walk(root, font: font)
      }
    }
  }

  private static func walk(_ view: UIView, font: UIFont?) {
    let name = NSStringFromClass(type(of: view))
    if name.contains("UILayoutContainerView") || name.contains("TabHostingController") {
      view.backgroundColor = .clear
    }
    if let font, name.contains("_UITabButton"), let label = view as? UILabel {
      label.font = font
    }
    for child in view.subviews {
      walk(child, font: font)
    }
  }
}
