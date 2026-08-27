import ExpoModulesCore
import StoreKit

public final class StellaStorefrontModule: Module {
  private var storefrontObserver: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("StellaStorefront")

    Events("onStorefrontChange")

    AsyncFunction("getStorefrontCountryCode") { () async -> String? in
      if #available(iOS 15.0, *) {
        let storefront = await Storefront.current
        return storefront?.countryCode
      }
      return SKPaymentQueue.default().storefront?.countryCode
    }

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
