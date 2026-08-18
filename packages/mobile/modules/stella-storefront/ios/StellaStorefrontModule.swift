import ExpoModulesCore
import StoreKit

// Surfaces the device's current App Store storefront country code to
// JavaScript. This is Apple's own determination of which App Store the
// signed-in Apple Account belongs to (StoreKit `Storefront`), which is the
// App-Review-defensible signal Apple and Stripe direct apps to use for
// region-gated external purchase behavior. It is deliberately NOT device
// locale, Apple ID region guesses, or IP geolocation.
public final class StellaStorefrontModule: Module {
  private var storefrontObserver: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("StellaStorefront")

    Events("onStorefrontChange")

    // Resolves to the ISO 3166-1 alpha-3 code (e.g. "USA") of the current
    // storefront, or nil when it cannot be established (no App Store
    // account signed in, StoreKit unavailable). Callers must fail closed on
    // nil.
    AsyncFunction("getStorefrontCountryCode") { () async -> String? in
      if #available(iOS 15.0, *) {
        let storefront = await Storefront.current
        return storefront?.countryCode
      }
      return SKPaymentQueue.default().storefront?.countryCode
    }

    // Emit whenever the storefront changes at runtime (e.g. the user
    // switches App Store region) so the UI can re-gate without a restart.
    OnStartObserving {
      guard #available(iOS 15.0, *) else { return }
      self.storefrontObserver?.cancel()
      self.storefrontObserver = Task { [weak self] in
        for await storefront in Storefront.updates {
          self?.sendEvent("onStorefrontChange", [
            "countryCode": storefront.countryCode
          ])
        }
      }
    }

    OnStopObserving {
      self.storefrontObserver?.cancel()
      self.storefrontObserver = nil
    }
  }
}
