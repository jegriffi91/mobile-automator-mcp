/**
 * Loupe sub-package — UI automation via the in-process Loupe HTTP server.
 *
 * Loupe (heoblitz/Loupe) injects a dylib into an iOS Simulator app process
 * and exposes its UI hierarchy + HID actions over loopback HTTP. This package
 * provides an `AutomationDriver` (`LoupeDriver`) that routes hierarchy +
 * tap/type through that injected server while delegating `runTest`, setup
 * and teardown back to the Maestro CLI so synthesized YAML remains
 * Maestro-compatible.
 */

export { LoupeClient, resolveLoupeBin } from './client.js';
export type { LoupeClientOptions, LoupeCompactObservation } from './client.js';
export { LoupeDriver } from './loupe-driver.js';
export { loupeToHierarchy } from './hierarchy.js';
export type { LoupeAccessibilityTree, LoupeAccessibilityNode } from './hierarchy.js';
