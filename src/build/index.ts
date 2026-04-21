/**
 * Build sub-package — Platform-specific build / install / boot / uninstall helpers.
 *
 * iOS: shells xcodebuild + xcrun simctl. Finds the resulting .app bundle in the
 * derived-data products directory and extracts the bundle identifier.
 *
 * Android: shells ./gradlew + adb. Finds the APK under the module's build outputs.
 *
 * Platform-agnostic orchestration lives in handlers.ts.
 */

export {
    buildIosApp,
    installIosApp,
    uninstallIosApp,
    bootIosSimulator,
} from './ios-build.js';
export type {
    IosBuildOptions,
    IosBuildResult,
    IosInstallOptions,
    IosInstallResult,
    IosUninstallOptions,
    IosUninstallResult,
    IosBootOptions,
    IosBootResult,
} from './ios-build.js';

export {
    buildAndroidApp,
    installAndroidApp,
    uninstallAndroidApp,
} from './android-build.js';
export type {
    AndroidBuildOptions,
    AndroidBuildResult,
    AndroidInstallOptions,
    AndroidInstallResult,
    AndroidUninstallOptions,
    AndroidUninstallResult,
} from './android-build.js';

export {
    findAppBundles,
    findApkFiles,
    extractIosBundleId,
    truncateOutput,
} from './utils.js';
