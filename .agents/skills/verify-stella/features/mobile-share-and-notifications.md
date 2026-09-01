# Mobile sharing and notifications

The mobile app receives shared content, responds to deep links and notifications, and sends generated files through the native share sheet.

## Sub-features

- `mobile-share-in` imports text, URLs, images, or files from the OS share flow.
- `mobile-deep-link` routes supported Stella URLs to the intended screen.
- `mobile-notification` opens the associated conversation or destination.
- `mobile-share-out` presents the native share sheet for a generated artifact.

## How to get to it (user POV)

- Share supported content to Stella from another iOS app.
- Open a supported `stella-mobile://` deep link.
- Tap a delivered Stella notification.
- Choose Share or Save from a chat artifact or generated PDF.

## Driving it with control-stella-ios

Preconditions:

- The app is installed and signed in on the simulator.
- Notification delivery and some share extensions may require capabilities unavailable in Simulator.

- **Deep link.** Run `control-stella-ios.sh open-url '<supported-url>'`, then capture `frame` and require the intended destination.
- **Share in.** Use a simulator-supported source app or fixture, invoke the system share sheet, choose Stella, and require imported context in the destination composer/screen.
- **Notification.** When delivery is available, tap one notification and require the matching conversation/destination. Otherwise report the simulator capability blocker.
- **Share out.** Open a real artifact, choose its share action, and require the native share sheet with the correct file type/name.
- **Proof.** Capture app frames before and after. Use a whole-screen capture for native sheets because simulator framebuffer images can omit surrounding macOS context.

## Gotchas

- Deep links must use routes the app actually registers. Do not guess a URL shape.
- Push delivery, share extensions, and background behavior can differ on physical devices.
- Native share sheets can expose personal destinations. Crop or redact artifacts.
- Opening a URL is navigation proof, not proof that the originating notification or share extension works.
