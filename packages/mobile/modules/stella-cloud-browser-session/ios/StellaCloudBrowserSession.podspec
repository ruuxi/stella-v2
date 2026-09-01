Pod::Spec.new do |s|
  s.name           = 'StellaCloudBrowserSession'
  s.version        = '1.0.0'
  s.summary        = 'Captures exact-origin WebKit cookies for cloud browser handoff.'
  s.description    = 'Reads bounded cookies from the default WebKit data store without exposing page DOM or form values.'
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
