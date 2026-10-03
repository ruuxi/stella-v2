import CryptoKit
import Foundation
import Security

/// Signs and verifies the app tree (step 5b).
///
/// The signature is ECDSA P-256 / SHA-256 over `stella-tree-v1\n<HEAD^{tree}>\n`,
/// DER-encoded, stored base64 as a git note under `refs/notes/stella-signed`
/// on the commit. Notes are local; each device signs its own applies.
///
/// The private key lives in the login keychain as an item this launcher
/// creates (the keychain's default ACL trusts only the creating app, so other
/// programs get a prompt). `STELLA_LAUNCHER_KEY_FILE` points at a 0600 PEM
/// instead, for testing on machines whose keychain is unavailable.
final class TreeSigner {
    static let notesRef = "stella-signed"
    static let keychainService = "sh.stella.launcher.tree-signing"
    static let keychainAccount = "p256"

    private let key: P256.Signing.PrivateKey

    init(paths: LauncherPaths) throws {
        if let file = ProcessInfo.processInfo.environment["STELLA_LAUNCHER_KEY_FILE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !file.isEmpty {
            key = try TreeSigner.loadOrCreateFileKey(URL(fileURLWithPath: (file as NSString).expandingTildeInPath))
        } else {
            key = try TreeSigner.loadOrCreateKeychainKey()
        }
        let pem = key.publicKey.pemRepresentation + "\n"
        if (try? String(contentsOf: paths.signingPub, encoding: .utf8)) != pem {
            try pem.write(to: paths.signingPub, atomically: true, encoding: .utf8)
        }
    }

    /// Base64 SPKI DER: the value of `STELLA_LAUNCHER_PUBKEY` for Electron.
    var publicKeySPKIBase64: String { key.publicKey.derRepresentation.base64EncodedString() }

    static func message(tree: String) -> Data { Data("stella-tree-v1\n\(tree)\n".utf8) }

    func signature(tree: String) throws -> String {
        try key.signature(for: TreeSigner.message(tree: tree)).derRepresentation.base64EncodedString()
    }

    func verify(tree: String, note: String) -> Bool {
        guard let der = Data(base64Encoded: note.trimmingCharacters(in: .whitespacesAndNewlines)),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: der)
        else { return false }
        return key.publicKey.isValidSignature(signature, for: TreeSigner.message(tree: tree))
    }

    enum Verdict: CustomStringConvertible {
        case signed
        case unsigned(head: String)
        case badSignature(head: String)
        case dirty([String])

        var description: String {
            switch self {
            case .signed: return "signed"
            case let .unsigned(head): return "HEAD \(head.prefix(12)) has no signature"
            case let .badSignature(head): return "HEAD \(head.prefix(12)) has an invalid signature"
            case let .dirty(files): return "\(files.count) uncommitted file(s): \(files.prefix(5).joined(separator: ", "))"
            }
        }
    }

    /// Before every spawn: HEAD's note must verify and the tree must be clean
    /// (untracked files count, because the renderer globs the source tree).
    func verifyHead(git: GitTool, app: URL) throws -> Verdict {
        let dirty = try changedFiles(git: git, app: app)
        if !dirty.isEmpty { return .dirty(dirty) }
        let head = try git.run(["rev-parse", "HEAD"], cwd: app)
        let tree = try git.run(["rev-parse", "HEAD^{tree}"], cwd: app)
        let note = try git.raw(["notes", "--ref", TreeSigner.notesRef, "show", head], cwd: app)
        guard note.code == 0 else { return .unsigned(head: head) }
        return verify(tree: tree, note: note.stdout) ? .signed : .badSignature(head: head)
    }

    /// Sign HEAD after checking it is `expected` (when given) and clean.
    @discardableResult
    func signHead(git: GitTool, app: URL, expected: String?) throws -> String {
        let head = try git.run(["rev-parse", "HEAD"], cwd: app)
        if let expected, !expected.isEmpty, expected != head {
            throw LauncherError("HEAD is \(head.prefix(12)), not \(expected.prefix(12)).")
        }
        let dirty = try changedFiles(git: git, app: app)
        guard dirty.isEmpty else {
            throw LauncherError("The checkout has uncommitted changes: \(dirty.prefix(5).joined(separator: ", ")).")
        }
        let tree = try git.run(["rev-parse", "HEAD^{tree}"], cwd: app)
        let note = try signature(tree: tree)
        try git.run(["notes", "--ref", TreeSigner.notesRef, "add", "-f", "-m", note, head],
                    cwd: app, extraEnv: GitTool.identityEnv)
        log("signing: signed \(head.prefix(12)) tree \(tree.prefix(12))")
        return head
    }

    func changedFiles(git: GitTool, app: URL) throws -> [String] {
        try git.run(["status", "--porcelain=v1", "--untracked-files=all"], cwd: app)
            .split(separator: "\n").map { String($0) }.filter { !$0.isEmpty }
    }

    // MARK: Key storage

    private static func loadOrCreateFileKey(_ url: URL) throws -> P256.Signing.PrivateKey {
        if FileManager.default.fileExists(atPath: url.path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            if let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 != 0 {
                throw LauncherError("\(url.path) must not be readable by other users (chmod 600).")
            }
            let pem = try String(contentsOf: url, encoding: .utf8)
            return try P256.Signing.PrivateKey(pemRepresentation: pem)
        }
        let key = P256.Signing.PrivateKey()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard FileManager.default.createFile(
            atPath: url.path, contents: Data((key.pemRepresentation + "\n").utf8),
            attributes: [.posixPermissions: 0o600])
        else { throw LauncherError("Could not write \(url.path).") }
        log("signing: generated a key file at \(url.path)")
        return key
    }

    private static func loadOrCreateKeychainKey() throws -> P256.Signing.PrivateKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return try P256.Signing.PrivateKey(rawRepresentation: data)
        }
        guard status == errSecItemNotFound else {
            throw LauncherError("Could not read the signing key from the keychain (\(status)).")
        }
        let key = P256.Signing.PrivateKey()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrLabel as String: "Stella app signing key",
            kSecValueData as String: key.rawRepresentation,
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else {
            throw LauncherError("Could not store the signing key in the keychain (\(added)).")
        }
        log("signing: generated a keychain key")
        return key
    }
}
