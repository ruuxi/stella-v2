import ExpoModulesCore
import Foundation
import WebKit

public final class StellaCloudBrowserSessionModule: Module {
  private static let maximumCookies = 128
  private static let maximumBytes = 32 * 1024

  public func definition() -> ModuleDefinition {
    Name("StellaCloudBrowserSession")

    AsyncFunction("captureCookies") { (rawURL: String) async throws -> [[String: Any]] in
      guard
        let url = URL(string: rawURL),
        url.scheme == "https",
        url.user == nil,
        url.password == nil,
        let hostname = url.host?.lowercased()
      else {
        throw Exception(name: "invalid_origin", description: "A valid HTTPS URL is required.")
      }

      let allCookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
      var totalBytes = 0
      var result: [[String: Any]] = []

      for cookie in allCookies where Self.applies(cookie: cookie, to: url, hostname: hostname) {
        guard result.count < Self.maximumCookies else {
          throw Exception(name: "session_too_large", description: "The site session contains too many cookies.")
        }
        let sameSite = Self.sameSite(cookie)
        let fields = [cookie.name, cookie.value, cookie.domain, cookie.path, sameSite]
        totalBytes += fields.reduce(0) { count, value in
          count + value.lengthOfBytes(using: .utf8)
        }
        guard totalBytes <= Self.maximumBytes else {
          throw Exception(name: "session_too_large", description: "The site session is too large to transfer.")
        }
        result.append([
          "name": cookie.name,
          "value": cookie.value,
          "domain": cookie.domain,
          "path": cookie.path.isEmpty ? "/" : cookie.path,
          "expires": cookie.expiresDate?.timeIntervalSince1970 ?? -1,
          "httpOnly": cookie.isHTTPOnly,
          "secure": cookie.isSecure,
          "sameSite": sameSite,
        ])
      }
      return result
    }
  }

  private static func applies(cookie: HTTPCookie, to url: URL, hostname: String) -> Bool {
    if let expires = cookie.expiresDate, expires.timeIntervalSinceNow <= 0 {
      return false
    }
    let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    guard hostname == domain || hostname.hasSuffix("." + domain) else {
      return false
    }
    return !cookie.isSecure || url.scheme == "https"
  }

  private static func sameSite(_ cookie: HTTPCookie) -> String {
    let key = HTTPCookiePropertyKey("SameSite")
    guard let raw = cookie.properties?[key] as? String else {
      return "Lax"
    }
    switch raw.lowercased() {
    case "strict": return "Strict"
    case "none": return "None"
    default: return "Lax"
    }
  }
}

private extension WKHTTPCookieStore {
  func allCookies() async -> [HTTPCookie] {
    await withCheckedContinuation { continuation in
      getAllCookies { cookies in
        continuation.resume(returning: cookies)
      }
    }
  }
}
