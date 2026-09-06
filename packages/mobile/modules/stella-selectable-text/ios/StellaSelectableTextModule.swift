import ExpoModulesCore
import UIKit
import React

public final class StellaSelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellaSelectableText")
    Constants(["supportsSelectionActions": true])
    View(StellaSelectableTextView.self) {
      Events("onLinkPress", "onAskStella")
      Prop("askStellaEnabled") { (view: StellaSelectableTextView, value: Bool) in
        view.textView.onAskStella = value ? { [weak view] text in view?.onAskStella(["text": text]) } : nil
      }
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
  let textView = StellaSelectionTextView(frame: .zero)
  let onLinkPress = EventDispatcher()
  let onAskStella = EventDispatcher()
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
        size: NSNumber(value: size), weight: run["fontWeight"] as? String,
        style: (run["italic"] as? Bool == true) ? "italic" : nil,
        variant: nil, scaleMultiplier: 1) ?? UIFont.systemFont(ofSize: size)
      let paragraph = NSMutableParagraphStyle()
      paragraph.minimumLineHeight = CGFloat(size * 1.5)
      paragraph.maximumLineHeight = CGFloat(size * 1.5)
      var attributes: [NSAttributedString.Key: Any] = [.font: resolvedFont, .paragraphStyle: paragraph]
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

  func textViewDidChangeSelection(_ textView: UITextView) {
    self.textView.selectionDidChange()
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    self.textView.dismissSelection()
  }

  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange,
    suggestedActions: [UIMenuElement]) -> UIMenu? {
    self.textView.selectionMenu(for: [range])
  }

  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, willDismissEditMenuWith animator: UIEditMenuInteractionAnimating) {
    self.textView.menuWillDismiss()
    animator.addCompletion { [weak self] in self?.textView.menuDidDismiss() }
  }

  @available(iOS 26.0, *)
  func textView(_ textView: UITextView, editMenuForTextInRanges ranges: [NSValue],
    suggestedActions: [UIMenuElement]) -> UIMenu? {
    self.textView.selectionMenu(for: ranges.map { $0.rangeValue })
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
