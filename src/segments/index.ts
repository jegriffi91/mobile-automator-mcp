/**
 * Segments sub-package — Flow deduplication via fingerprinting.
 *
 * Responsible for:
 *   • Computing deterministic fingerprints from correlated recording steps
 *   • Managing a persistent registry of named, reusable flow segments
 *   • Detecting duplicate recordings via exact fingerprint matching
 */

export { SegmentFingerprint } from './fingerprint.js';
export { SegmentRegistry } from './registry.js';
export type { SegmentEntry, SegmentMatch } from './registry.js';
