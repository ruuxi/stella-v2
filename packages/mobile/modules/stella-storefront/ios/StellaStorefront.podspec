Pod::Spec.new do |s|
  s.name           = 'StellaStorefront'
  s.version        = '1.0.0'
  s.summary        = 'Reads the current App Store storefront country from StoreKit.'
  s.description    = 'Exposes the current StoreKit storefront country code so the app can gate ' \
                     'region-restricted external checkout on Apple\'s own storefront signal ' \
                     'rather than device locale or IP.'
  s.author         = 'FromYou, LLC'
  s.homepage       = 'https://stella.sh'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.license        = { :type => 'MIT' }

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
