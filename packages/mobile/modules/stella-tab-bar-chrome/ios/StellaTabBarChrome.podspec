Pod::Spec.new do |s|
  s.name           = 'StellaTabBarChrome'
  s.version        = '1.0.0'
  s.summary        = 'Fits the system tab bar into the app chrome.'
  s.description    = 'Clears the page background behind a hosted SwiftUI TabView and sets ' \
                     'its tab titles in the app font, through UIAppearance.'
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
