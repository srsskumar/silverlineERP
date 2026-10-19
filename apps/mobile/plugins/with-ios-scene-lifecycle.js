const {
  withAppDelegate,
  withInfoPlist,
  withXcodeProject,
  withDangerousMod,
  IOSConfig,
} = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

/**
 * iOS 27's SDK makes UIScene lifecycle adoption mandatory: an app with no
 * UIApplicationSceneManifest and no scene delegate now hard-crashes on launch
 * (EXC_BREAKPOINT in ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption)
 * instead of just logging a deprecation warning the way it used to. Expo's
 * own scene-lifecycle support lands in SDK 58; this project is pinned to SDK
 * 57, which still generates the legacy AppDelegate-only template, so every
 * build made with an iOS 27 SDK (Xcode 27+) crashes immediately on open.
 *
 * This is a minimal, scoped compatibility shim -- not a scene-lifecycle
 * migration. It keeps the app's single-window, AppDelegate-owned model
 * exactly as it was; the new SceneDelegate does nothing but create the one
 * window UIKit now requires and hand launch/URL/activity events straight to
 * AppDelegate's existing, unmodified handlers, so deep linking and cold-start
 * behavior keep working exactly as before.
 *
 * Revisit and remove this plugin once the app upgrades to Expo SDK 58+,
 * which ships scene-lifecycle support natively.
 */
function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return config;
  });

  config = withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    const propertyAnchor = '  var window: UIWindow?\n';
    if (!contents.includes(propertyAnchor)) {
      throw new Error(
        'with-ios-scene-lifecycle: "var window: UIWindow?" not found in AppDelegate.swift -- the Expo template changed, update this plugin.',
      );
    }
    contents = contents.replace(
      propertyAnchor,
      `${propertyAnchor}  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n`,
    );

    const launchAnchor = '    let delegate = ReactNativeDelegate()';
    if (!contents.includes(launchAnchor)) {
      throw new Error(
        'with-ios-scene-lifecycle: "let delegate = ReactNativeDelegate()" not found in AppDelegate.swift -- update this plugin.',
      );
    }
    contents = contents.replace(launchAnchor, `    self.launchOptions = launchOptions\n${launchAnchor}`);

    const windowBlock =
      '#if os(iOS) || os(tvOS)\n' +
      '    window = UIWindow(frame: UIScreen.main.bounds)\n' +
      '    factory.startReactNative(\n' +
      '      withModuleName: "main",\n' +
      '      in: window,\n' +
      '      launchOptions: launchOptions)\n' +
      '#endif\n';
    if (!contents.includes(windowBlock)) {
      throw new Error(
        'with-ios-scene-lifecycle: expected window-creation block not found in AppDelegate.swift -- update this plugin.',
      );
    }
    contents = contents.replace(
      windowBlock,
      '// Window creation moved to SceneDelegate -- see plugins/with-ios-scene-lifecycle.js.\n',
    );

    const linkingMarker = '  // Linking API';
    if (!contents.includes(linkingMarker)) {
      throw new Error(
        'with-ios-scene-lifecycle: "// Linking API" marker not found in AppDelegate.swift -- update this plugin.',
      );
    }
    const configuratorMethod =
      '  public func application(\n' +
      '    _ application: UIApplication,\n' +
      '    configurationForConnecting connectingSceneSession: UISceneSession,\n' +
      '    options: UIScene.ConnectionOptions\n' +
      '  ) -> UISceneConfiguration {\n' +
      '    return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)\n' +
      '  }\n\n';
    contents = contents.replace(linkingMarker, `${configuratorMethod}${linkingMarker}`);

    config.modResults.contents = contents;
    return config;
  });

  config = withDangerousMod(config, [
    'ios',
    (config) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
      const dir = path.join(config.modRequest.platformProjectRoot, projectName);
      fs.writeFileSync(path.join(dir, 'SceneDelegate.swift'), SCENE_DELEGATE_SOURCE);
      return config;
    },
  ]);

  config = withXcodeProject(config, (config) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: path.join(projectName, 'SceneDelegate.swift'),
      groupName: projectName,
      project: config.modResults,
    });
    return config;
  });

  return config;
}

const SCENE_DELEGATE_SOURCE = `import UIKit
import React

/**
 * Minimal iOS-27-compatibility shim -- see plugins/with-ios-scene-lifecycle.js.
 * Owns nothing but the one window UIKit now requires; all real app and
 * linking logic stays in AppDelegate, reused as-is from here.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: appDelegate.launchOptions)
    self.window = window
    window.makeKeyAndVisible()

    if let urlContext = connectionOptions.urlContexts.first {
      _ = appDelegate.application(UIApplication.shared, open: urlContext.url, options: [:])
    }
    if let userActivity = connectionOptions.userActivities.first {
      _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

module.exports = withIosSceneLifecycle;
