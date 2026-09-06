# Native selection checks

`main.swift` exercises the real UIKit text view and its UIActions in a Simulator process. It verifies UTF-16 selection extraction, Ask Stella's exact substring, menu contents, unchanged attributed formatting, non-consuming outside-tap configuration, single selection ownership across blocks, unmount cleanup, delayed dismissal, stale-dismissal fencing, and the edit-menu animation race.

Compile `ios/StellaSelectionTextView.swift` together with `tests/main.swift` using `xcrun swiftc`, an iOS Simulator SDK and an arm64 Simulator target (minimum iOS 16). Sign the resulting executable ad hoc, then run it with `xcrun simctl spawn <owned-simulator-UDID> <absolute-executable-path>`. No app authentication or network is involved.

These are code-level checks, not physical UI acceptance. The Copy UIAction executes and clears selection, but pasteboard bytes must be verified by pasting in the actual app: a pasteboard read from the standalone executable hung inside UIKit. Real long-press word selection, handle drags, menu taps and outside taps must also be checked in the app after its native build.
