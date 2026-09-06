Pod::Spec.new do |s|
  s.name = 'StellaSelectableText'
  s.version = '1.0.0'
  s.summary = 'Native selectable formatted assistant text.'
  s.description = 'UIKit attributed text with word selection and standard selection handles.'
  s.author = 'FromYou, LLC'
  s.homepage = 'https://stella.sh'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.license = { :type => 'MIT' }
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
