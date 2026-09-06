import UIKit

/// Keeps UIKit's attributed text selection and handles, with Stella's two actions.
final class StellaSelectionTextView: UITextView, UIGestureRecognizerDelegate {
  var onAskStella: ((String) -> Void)?
  private static weak var selectedView: StellaSelectionTextView?
  private var outsideTap: UITapGestureRecognizer?
  private var previousMenuItems: [UIMenuItem]?
  private var selectionRevision = 0
  private var observedRange = NSRange(location: 0, length: 0)
  private var menuIsDismissing = false
  private var afterMenuDismiss: (() -> Void)?

  func selectionDidChange() {
    if observedRange != selectedRange {
      selectionRevision += 1
      observedRange = selectedRange
    }
    guard selectedRange.length > 0, let window else {
      removeOutsideTap()
      return
    }
    if Self.selectedView !== self {
      Self.selectedView?.dismissSelection()
      Self.selectedView = self
    }
    guard outsideTap == nil else { return }
    let tap = UITapGestureRecognizer(target: self, action: #selector(tappedOutside))
    tap.cancelsTouchesInView = false
    tap.delaysTouchesBegan = false
    tap.delaysTouchesEnded = false
    tap.delegate = self
    window.addGestureRecognizer(tap)
    outsideTap = tap
    if #unavailable(iOS 16.0) {
      previousMenuItems = UIMenuController.shared.menuItems
      UIMenuController.shared.menuItems = onAskStella == nil ? [] : [
        UIMenuItem(title: "Ask Stella", action: #selector(askStella(_:)))
      ]
    }
  }

  func dismissSelection() {
    selectionRevision += 1
    afterMenuDismiss = nil
    selectedRange = NSRange(location: 0, length: 0)
    resignFirstResponder()
    removeOutsideTap()
  }

  private func removeOutsideTap() {
    if let tap = outsideTap { tap.view?.removeGestureRecognizer(tap) }
    outsideTap = nil
    if Self.selectedView === self {
      Self.selectedView = nil
      if #unavailable(iOS 16.0) {
        UIMenuController.shared.menuItems = previousMenuItems
      }
    }
    previousMenuItems = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { dismissSelection() }
  }

  deinit {
    if let tap = outsideTap { tap.view?.removeGestureRecognizer(tap) }
  }

  @objc private func tappedOutside() {
    scheduleOutsideDismissal()
  }

  func scheduleOutsideDismissal() {
    let revision = selectionRevision
    let range = selectedRange
    let dismiss = { [weak self] in
      guard let self, self.selectionRevision == revision,
        self.selectedRange == range, range.length > 0 else { return }
      self.dismissSelection()
    }
    // Give the original control/menu action the current event first. An edit
    // menu dismissal animation can defer its UIAction; in that case wait for
    // UIKit's completion, without racing a new selection or Ask/Copy action.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if self.menuIsDismissing { self.afterMenuDismiss = dismiss }
      else { dismiss() }
    }
  }

  func menuWillDismiss() { menuIsDismissing = true }

  func menuDidDismiss() {
    menuIsDismissing = false
    let pending = afterMenuDismiss
    afterMenuDismiss = nil
    pending?()
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard selectedRange.length > 0, let touchedView = touch.view else { return false }
    // UIKit owns taps on selected words and drags on selection handles. The
    // observer only sees taps outside this text view and never consumes them.
    guard !touchedView.isDescendant(of: self) else { return false }
    if #available(iOS 17.0, *) {
      for interaction in interactions {
        guard let display = interaction as? UITextSelectionDisplayInteraction else { continue }
        if display.handleViews.contains(where: { touchedView.isDescendant(of: $0) }) { return false }
      }
    }
    // Selection handles may be hosted outside the text view's hierarchy.
    // Public selection geometry protects their touch targets on older iOS too.
    if let range = selectedTextRange {
      let point = touch.location(in: self)
      for rect in selectionRects(for: range) where rect.containsStart || rect.containsEnd {
        if rect.rect.insetBy(dx: -22, dy: -22).contains(point) { return false }
      }
    }
    return true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

  func selectedText(in ranges: [NSRange]) -> String {
    let source = (attributedText?.string ?? text ?? "") as NSString
    return ranges.compactMap { range -> String? in
      guard range.location != NSNotFound, range.location <= source.length,
        range.length > 0, range.length <= source.length - range.location else { return nil }
      return source.substring(with: range)
    }.joined(separator: "\n")
  }

  @available(iOS 16.0, *)
  func selectionMenu(for ranges: [NSRange]) -> UIMenu {
    let selected = selectedText(in: ranges)
    guard !selected.isEmpty else { return UIMenu(children: []) }
    var actions: [UIAction] = []
    if onAskStella != nil {
      actions.append(UIAction(title: "Ask Stella") { [weak self] _ in
        guard let self else { return }
        self.dismissSelection()
        self.onAskStella?(selected)
      })
    }
    actions.append(UIAction(title: "Copy") { [weak self] _ in
      UIPasteboard.general.string = selected
      self?.dismissSelection()
    })
    return UIMenu(children: actions)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    guard selectedRange.length > 0 else { return false }
    return action == #selector(copy(_:)) || (action == #selector(askStella(_:)) && onAskStella != nil)
  }

  override func copy(_ sender: Any?) {
    let selected = selectedText(in: [selectedRange])
    if !selected.isEmpty { UIPasteboard.general.string = selected }
    dismissSelection()
  }

  @objc func askStella(_ sender: Any?) {
    let selected = selectedText(in: [selectedRange])
    dismissSelection()
    if !selected.isEmpty { onAskStella?(selected) }
  }
}
