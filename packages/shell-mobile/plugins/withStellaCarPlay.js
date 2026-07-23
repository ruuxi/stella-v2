const {
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const CAR = "StellaCarSceneDelegate";
const PHONE = "StellaPhoneSceneDelegate";
const VOICE = "StellaCarVoice";
const networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;

const carHeader = `#import <UIKit/UIKit.h>
#import <CarPlay/CarPlay.h>
@interface ${CAR} : UIResponder <CPTemplateApplicationSceneDelegate>
@end
`;

const carImplementation = `#import "${CAR}.h"
#import "RNCarPlay.h"
@implementation ${CAR}
- (void)templateApplicationScene:(CPTemplateApplicationScene *)scene
   didConnectInterfaceController:(CPInterfaceController *)controller {
  [RNCarPlay connectWithInterfaceController:controller window:scene.carWindow];
}
- (void)templateApplicationScene:(CPTemplateApplicationScene *)scene
didDisconnectInterfaceController:(CPInterfaceController *)controller {
  [RNCarPlay disconnect];
}
@end
`;

const phoneImplementation = `import UIKit
@objc(${PHONE})
final class ${PHONE}: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let appWindow = appDelegate.window else { return }
    appWindow.windowScene = windowScene
    window = appWindow
    appWindow.makeKeyAndVisible()
  }
  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    for context in contexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: context.url,
        options: [:]
      )
    }
  }
}
`;

const voiceHeader = `#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
@interface ${VOICE} : RCTEventEmitter <RCTBridgeModule>
@end
`;

const voiceImplementation = `#import "${VOICE}.h"
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>

@interface ${VOICE} ()
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVSpeechSynthesizer *synthesizer;
@end

@implementation ${VOICE}
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (NSArray<NSString *> *)supportedEvents {
  return @[@"StellaCarVoiceTranscript", @"StellaCarVoiceError"];
}
- (instancetype)init {
  if ((self = [super init])) {
    _recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale currentLocale]];
    _engine = [AVAudioEngine new];
    _synthesizer = [AVSpeechSynthesizer new];
  }
  return self;
}
RCT_EXPORT_METHOD(startListening) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
          [self sendEventWithName:@"StellaCarVoiceError" body:@{@"message": @"Speech recognition permission is required."}];
          return;
        }
        [self stopCapture:NO];
        NSError *sessionError = nil;
        AVAudioSession *session = AVAudioSession.sharedInstance;
        [session setCategory:AVAudioSessionCategoryRecord
                        mode:AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionDuckOthers
                       error:&sessionError];
        [session setActive:YES
              withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                    error:&sessionError];
        if (sessionError) {
          [self sendEventWithName:@"StellaCarVoiceError" body:@{@"message": sessionError.localizedDescription}];
          return;
        }
        self.request = [SFSpeechAudioBufferRecognitionRequest new];
        self.request.shouldReportPartialResults = YES;
        AVAudioInputNode *input = self.engine.inputNode;
        AVAudioFormat *format = [input outputFormatForBus:0];
        [input installTapOnBus:0 bufferSize:1024 format:format
                         block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
          [self.request appendAudioPCMBuffer:buffer];
        }];
        __weak typeof(self) weakSelf = self;
        self.task = [self.recognizer recognitionTaskWithRequest:self.request
          resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
          __strong typeof(weakSelf) self = weakSelf;
          if (!self) return;
          if (result.isFinal) {
            NSString *text = result.bestTranscription.formattedString ?: @"";
            [self sendEventWithName:@"StellaCarVoiceTranscript" body:@{@"text": text}];
            [self stopCapture:YES];
          } else if (error) {
            [self sendEventWithName:@"StellaCarVoiceError" body:@{@"message": error.localizedDescription ?: @"Voice input failed."}];
            [self stopCapture:NO];
          }
        }];
        [self.engine prepare];
        NSError *engineError = nil;
        [self.engine startAndReturnError:&engineError];
        if (engineError) {
          [self sendEventWithName:@"StellaCarVoiceError" body:@{@"message": engineError.localizedDescription}];
          [self stopCapture:NO];
        }
      });
    }];
  });
}
RCT_EXPORT_METHOD(stopListening) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.request endAudio];
    [self.engine stop];
    [self.engine.inputNode removeTapOnBus:0];
  });
}
RCT_EXPORT_METHOD(speak:(NSString *)text) {
  if (text.length == 0) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:text];
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate;
    [self.synthesizer speakUtterance:utterance];
  });
}
- (void)stopCapture:(BOOL)finish {
  if (self.engine.isRunning) [self.engine stop];
  @try { [self.engine.inputNode removeTapOnBus:0]; } @catch (__unused NSException *exception) {}
  [self.request endAudio];
  [self.task cancel];
  self.task = nil;
  self.request = nil;
  [AVAudioSession.sharedInstance setActive:NO
    withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
}
@end
`;

module.exports = function withStellaCarPlay(config) {
  config = withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application) {
      application.$["android:networkSecurityConfig"] =
        "@xml/stella_network_security_config";
    }
    return next;
  });
  config = withDangerousMod(config, [
    "android",
    async (next) => {
      const xmlRoot = path.join(
        next.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(xmlRoot, { recursive: true });
      fs.writeFileSync(
        path.join(xmlRoot, "stella_network_security_config.xml"),
        networkSecurityConfig,
      );
      return next;
    },
  ]);
  config = withEntitlementsPlist(config, (next) => {
    next.modResults["com.apple.developer.carplay-audio"] = true;
    return next;
  });
  config = withInfoPlist(config, (next) => {
    next.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Stella-Phone",
            UISceneDelegateClassName: PHONE,
          },
        ],
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: "CPTemplateApplicationScene",
            UISceneConfigurationName: "Stella-CarPlay",
            UISceneDelegateClassName: CAR,
          },
        ],
      },
    };
    return next;
  });
  config = withDangerousMod(config, [
    "ios",
    async (next) => {
      const projectRoot = next.modRequest.platformProjectRoot;
      const projectName = next.modRequest.projectName;
      const sourceRoot = path.join(projectRoot, projectName);
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, `${CAR}.h`), carHeader);
      fs.writeFileSync(path.join(sourceRoot, `${CAR}.m`), carImplementation);
      fs.writeFileSync(
        path.join(sourceRoot, `${PHONE}.swift`),
        phoneImplementation,
      );
      fs.writeFileSync(path.join(sourceRoot, `${VOICE}.h`), voiceHeader);
      fs.writeFileSync(
        path.join(sourceRoot, `${VOICE}.m`),
        voiceImplementation,
      );
      return next;
    },
  ]);
  return withXcodeProject(config, (next) => {
    const projectName = next.modRequest.projectName;
    for (const file of [`${CAR}.m`, `${PHONE}.swift`, `${VOICE}.m`]) {
      const relative = `${projectName}/${file}`;
      if (!next.modResults.hasFile(relative)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: relative,
          groupName: projectName,
          project: next.modResults,
        });
      }
    }
    return next;
  });
};
