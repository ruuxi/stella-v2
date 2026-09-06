import UIKit

// Compile with StellaSelectionTextView.swift for an iOS Simulator executable.
// Exercises the real UIKit menu/actions without needing a chat/network fixture.
@MainActor func runSelectionChecks() {
  let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
  let view = StellaSelectionTextView(frame: CGRect(x: 0, y: 100, width: 360, height: 100))
  window.addSubview(view)
  let rendered = NSMutableAttributedString(string: "Hello 🌍 bold world")
  let boldRange = (rendered.string as NSString).range(of: "bold")
  rendered.addAttribute(.font, value: UIFont.boldSystemFont(ofSize: 17), range: boldRange)
  view.attributedText = rendered
  var asked: [String] = []
  view.onAskStella = { asked.append($0) }
  view.selectedRange = boldRange
  view.selectionDidChange()
  assert(view.selectedText(in: [boldRange]) == "bold")
  assert(view.selectedText(in: [NSRange(location: NSNotFound, length: 1)]) == "")
  assert(view.selectedText(in: [NSRange(location: 1, length: Int.max)]) == "")
  assert(view.selectedText(in: [(rendered.string as NSString).range(of: "🌍")]) == "🌍")
  let observer = window.gestureRecognizers!.last!
  assert(observer.cancelsTouchesInView == false)
  assert(observer.delaysTouchesBegan == false && observer.delaysTouchesEnded == false)
  assert(view.canPerformAction(#selector(UIResponderStandardEditActions.selectAll(_:)), withSender: nil) == false)
  let menu = view.selectionMenu(for: [boldRange])
  assert(menu.children.map(\.title) == ["Ask Stella", "Copy"])
  let askButton = UIButton(type: .system)
  askButton.addAction(menu.children[0] as! UIAction, for: .touchUpInside)
  askButton.sendActions(for: .touchUpInside)
  assert(asked == ["bold"])
  assert(view.selectedRange.length == 0)
  assert(!(window.gestureRecognizers ?? []).contains(observer))
  assert(view.attributedText.isEqual(to: rendered))


  view.selectedRange = boldRange
  view.selectionDidChange()
  let second = StellaSelectionTextView(frame: view.frame)
  second.text = "Another paragraph"
  window.addSubview(second)
  second.selectedRange = NSRange(location: 0, length: 7)
  second.selectionDidChange()
  assert(view.selectedRange.length == 0)
  assert(second.selectedRange.length == 7)
  assert(second.selectionMenu(for: [second.selectedRange]).children.map(\.title) == ["Copy"])
  let secondObserver = window.gestureRecognizers!.last!
  second.removeFromSuperview()
  assert(second.selectedRange.length == 0)
  assert(!(window.gestureRecognizers ?? []).contains(secondObserver))
  // An outside tap is delayed so the original control action can run first.
  window.addSubview(view)
  view.selectedRange = boldRange
  view.selectionDidChange()
  view.scheduleOutsideDismissal()
  assert(view.selectedRange == boldRange)
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
  assert(view.selectedRange.length == 0)

  // A newer selection must survive a previously queued outside dismissal.
  view.selectedRange = boldRange
  view.selectionDidChange()
  view.scheduleOutsideDismissal()
  view.selectedRange = NSRange(location: 0, length: 5)
  view.selectionDidChange()
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
  assert(view.selectedRange == NSRange(location: 0, length: 5))

  // UIKit can defer its menu action until the dismissal animation finishes.
  view.selectedRange = boldRange
  view.selectionDidChange()
  let deferredMenu = view.selectionMenu(for: [boldRange])
  view.menuWillDismiss()
  view.scheduleOutsideDismissal()
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
  assert(view.selectedRange == boldRange)
  let deferredAsk = UIButton(type: .system)
  deferredAsk.addAction(deferredMenu.children[0] as! UIAction, for: .touchUpInside)
  deferredAsk.sendActions(for: .touchUpInside)
  view.menuDidDismiss()
  assert(asked == ["bold", "bold"])
  assert(view.selectedRange.length == 0)

  view.selectedRange = boldRange
  view.selectionDidChange()
  let copyMenu = view.selectionMenu(for: [boldRange])
  let copyButton = UIButton(type: .system)
  copyButton.addAction(copyMenu.children[1] as! UIAction, for: .touchUpInside)
  copyButton.sendActions(for: .touchUpInside)
  assert(asked == ["bold", "bold"] && view.selectedRange.length == 0)

  // A standalone Simulator CLI hung inside UIKit on pasteboard reads. Verify
  // clipboard bytes in the actual app acceptance pass, not this CLI process.
  print("PASS: exact Unicode selection, only Ask/Copy, quote callback, native copy, preserved formatting, non-consuming observer, cross-block ownership, unmount cleanup")
}
MainActor.assumeIsolated { runSelectionChecks() }
