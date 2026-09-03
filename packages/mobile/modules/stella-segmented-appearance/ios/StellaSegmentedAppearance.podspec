Pod::Spec.new do |s|
  s.name           = 'StellaSegmentedAppearance'
  s.version        = '1.0.0'
  s.summary        = 'Themes the system segmented control to match the app chrome.'
  s.description    = 'Sets UISegmentedControl appearance colours so the SwiftUI segmented ' \
                     'picker hosted in the sidebar matches the app\'s Liquid Glass chrome.'
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
