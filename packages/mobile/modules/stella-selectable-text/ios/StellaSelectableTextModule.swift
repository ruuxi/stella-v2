import ExpoModulesCore
import UIKit
import React

public final class StellaSelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellaSelectableText")
    View(StellaSelectableTextView.self) {
      Events("onLinkPress")
      Prop("runsJSON") { (view: StellaSelectableTextView, value: String) in
        view.setRuns(value)
      }
      Prop("alignment") { (view: StellaSelectableTextView, value: String) in
        view.textView.textAlignment = value == "center" ? .center : value == "right" ? .right : .left
      }
    }
  }
}

final class StellaSelectableTextView: ExpoView, UITextViewDelegate {
  let textView = UITextView(frame: .zero)
  let onLinkPress = EventDispatcher()
  private var lastJSON = ""

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.adjustsFontForContentSizeCategory = true
    textView.delegate = self
    textView.linkTextAttributes = [.underlineStyle: NSUnderlineStyle.single.rawValue]
    addSubview(textView)
  }

  func setRuns(_ json: String) {
    guard json != lastJSON, let data = json.data(using: .utf8),
      let runs = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
    lastJSON = json
    let text = NSMutableAttributedString(string: "")
    for run in runs {
      let size = run["fontSize"] as? Double ?? 17
      let resolvedFont = RCTFont.update(nil, withFamily: run["fontFamily"] as? String,
        size: NSNumber(value: size), weight: nil,
        style: (run["italic"] as? Bool == true) ? "italic" : nil,
        variant: nil, scaleMultiplier: 1) ?? UIFont.systemFont(ofSize: size)
      // Some custom families (including Manrope) have no italic face.
      // Preserve Markdown emphasis with a synthetic slant in that case.
      let font = run["italic"] as? Bool == true && !resolvedFont.fontDescriptor.symbolicTraits.contains(.traitItalic)
        ? UIFont(descriptor: resolvedFont.fontDescriptor.withMatrix(CGAffineTransform(a: 1, b: 0, c: 0.2, d: 1, tx: 0, ty: 0)), size: size)
        : resolvedFont
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = CGFloat(size * 1.5)
      paragraph.maximumLineHeight = CGFloat(size * 1.5)
      var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
      if let color = Self.color(run["color"] as? String) { attributes[.foregroundColor] = color }
      if let color = Self.color(run["backgroundColor"] as? String) { attributes[.backgroundColor] = color }
      if run["strikethrough"] as? Bool == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let href = run["href"] as? String, let url = URL(string: href) { attributes[.link] = url }
      text.append(NSAttributedString(string: run["text"] as? String ?? "", attributes: attributes))
    }
    textView.attributedText = text
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
  }

  func textView(_ textView: UITextView, shouldInteractWith URL: URL,
    in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    guard interaction == .invokeDefaultAction else { return true }
    onLinkPress(["url": URL.absoluteString])
    return false
  }

  private static func color(_ value: String?) -> UIColor? {
    guard let value else { return nil }
    if value.hasPrefix("rgb") {
      let pieces = value.components(separatedBy: CharacterSet(charactersIn: "rgba(), ")).filter { !$0.isEmpty }
      let channels = pieces.compactMap(Double.init)
      if channels.count == 3 || channels.count == 4 {
        return UIColor(red: CGFloat(channels[0] / 255), green: CGFloat(channels[1] / 255),
          blue: CGFloat(channels[2] / 255), alpha: CGFloat(channels.count == 4 ? channels[3] : 1))
      }
    }
    let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard let number = UInt64(hex, radix: 16), hex.count == 6 || hex.count == 8 else { return nil }
    let rgb = hex.count == 8 ? number >> 8 : number
    return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
      green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255,
      alpha: hex.count == 8 ? CGFloat(number & 255) / 255 : 1)
  }
}
