/**
 * WireMock sub-package — In-process stub server for test replay.
 *
 * Responsible for:
 *   • Loading WireMock-compatible mappings/ and __files/
 *   • Serving HTTP stub responses via Node's built-in http module
 *   • Zero external dependencies — no WireMock JAR needed
 */

export { StubServer } from './runner.js';
export { MockServer } from './mock-manager.js';
export type {
    MockSpec,
    MockMatcher,
    MockStaticResponse,
    MockResponseTransform,
} from './mock-manager.js';
export { applyPatch, JsonPatchError } from './json-patch.js';
export type { JsonPatchOp } from './json-patch.js';
