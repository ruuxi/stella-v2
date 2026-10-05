// swift-tools-version:5.9
import PackageDescription

// The macOS launcher: installs Stella's runtimes and source, gives Electron
// the Stella.app identity, verifies the signed tree, supervises the app and
// rolls back to the last working version. It lives outside the published app
// tree (scripts/publish-app-source.mjs excludes launcher/), so agents that
// modify Stella can't modify its trust anchor.
let package = Package(
    name: "StellaLauncher",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "StellaLauncher",
            path: "Sources/StellaLauncher",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CryptoKit"),
                .linkedFramework("Security"),
                .linkedFramework("WebKit"),
            ]
        ),
    ]
)
