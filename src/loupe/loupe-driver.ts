/**
 * LoupeDriver — AutomationDriver backed by Loupe's in-process HTTP server.
 *
 * Owns hierarchy ops (`dumpHierarchy*`, `createTreeReader`) and the
 * `executeAction` fast path for tap/type via the `loupe` CLI's native HID
 * dispatch. Everything else (`runTest`, setup, teardown, swipe/scroll,
 * `back`) delegates to an internal `MaestroWrapper` so synthesized YAML
 * stays Maestro-compatible end-to-end.
 *
 * Lifecycle:
 *   • `start(deviceId)` stores UDID; if `bundleId` was passed to the
 *     constructor, eagerly injects via `setAppContext(bundleId)`.
 *   • `setAppContext(bundleId)` (idempotent) spawns `loupe start --bundle-id`
 *     and waits for `/runtime` to become healthy. On failure, marks the
 *     driver `degraded` — every later hierarchy/action call delegates to the
 *     internal wrapper.
 *   • `stop()` best-effort calls `loupe stop --udid <udid>`.
 *
 * Failure model: Loupe never throws into handlers. A failed CLI invocation
 * or HTTP error degrades the driver to its Maestro wrapper for the rest of
 * the session.
 */

import { LoupeClient, type LoupeCompactObservation } from './client.js';
import { loupeToHierarchy } from './hierarchy.js';
import { MaestroWrapper } from '../maestro/wrapper.js';
import { HierarchyParser } from '../maestro/hierarchy.js';
import type { AutomationDriver, TreeHierarchyReader } from '../maestro/driver.js';
import type {
    MobilePlatform,
    TimeoutConfig,
    UIActionType,
    UIElement,
} from '../types.js';

const OBSERVATION_POLL_INTERVAL_MS = 250;
const OBSERVATION_SETTLE_TIMEOUT_MS = 5_000;

export class LoupeDriver implements AutomationDriver {
    private readonly wrapper: MaestroWrapper;
    private readonly client: LoupeClient;
    private deviceId?: string;
    private bundleId?: string;
    private injected = false;
    private degraded = false;
    /** Cached observation used to resolve element → ref lookups for taps. */
    private lastObservation?: LoupeCompactObservation;

    constructor(timeouts: TimeoutConfig, bundleId?: string, client?: LoupeClient) {
        this.wrapper = new MaestroWrapper(undefined, timeouts);
        this.client = client ?? new LoupeClient();
        this.bundleId = bundleId;
    }

    // ── Lifecycle ──

    async start(deviceId?: string): Promise<void> {
        this.deviceId = deviceId;
        if (this.bundleId && deviceId && !this.injected) {
            await this.injectOrDegrade(deviceId, this.bundleId);
        }
    }

    async stop(): Promise<void> {
        try {
            await this.client.stop();
        } catch {
            /* ignore */
        }
        this.injected = false;
    }

    get isRunning(): boolean {
        return this.injected && !this.degraded;
    }

    async setAppContext(bundleId: string): Promise<void> {
        // Idempotent: noop on same bundle id; switch otherwise.
        if (this.injected && this.bundleId === bundleId) return;
        if (this.injected) {
            await this.client.stop();
            this.injected = false;
        }
        this.bundleId = bundleId;
        if (this.deviceId) {
            await this.injectOrDegrade(this.deviceId, bundleId);
        }
    }

    private async injectOrDegrade(deviceId: string, bundleId: string): Promise<void> {
        try {
            await this.client.start(deviceId, bundleId);
            this.injected = true;
            this.degraded = false;
            console.error(`[LoupeDriver] injected into ${bundleId} on ${deviceId}`);
        } catch (err) {
            this.injected = false;
            this.degraded = true;
            console.error(
                '[LoupeDriver] injection failed — delegating to Maestro for this session:',
                err,
            );
        }
    }

    // ── Hierarchy ──

    async dumpHierarchy(): Promise<string> {
        if (!this.canUseLoupe()) return this.wrapper.dumpHierarchy();
        try {
            const tree = await this.client.getAccessibility();
            return JSON.stringify(loupeToHierarchy(tree));
        } catch (err) {
            console.error('[LoupeDriver] /accessibility failed, falling back to Maestro:', err);
            return this.wrapper.dumpHierarchy();
        }
    }

    async dumpHierarchyLite(): Promise<string> {
        // Loupe's accessibility tree is already pre-filtered upstream — no
        // separate "lite" endpoint, so /accessibility serves both calls.
        return this.dumpHierarchy();
    }

    async dumpHierarchyUntilSettled(
        settleTimeoutMs = OBSERVATION_SETTLE_TIMEOUT_MS,
    ): Promise<{ hierarchy: string; settleDurationMs: number }> {
        if (!this.canUseLoupe()) {
            return this.wrapper.dumpHierarchyUntilSettled(settleTimeoutMs);
        }
        const started = Date.now();
        const deadline = started + settleTimeoutMs;
        let lastFp: string | undefined;
        let stableHits = 0;
        while (Date.now() < deadline) {
            try {
                const obs = await this.client.getObservation();
                const fp = fingerprintObservation(obs);
                if (fp === lastFp) {
                    stableHits++;
                    if (stableHits >= 2) {
                        this.lastObservation = obs;
                        break;
                    }
                } else {
                    stableHits = 0;
                    lastFp = fp;
                }
            } catch (err) {
                console.error('[LoupeDriver] /observation failed during settle:', err);
                break;
            }
            await new Promise((r) => setTimeout(r, OBSERVATION_POLL_INTERVAL_MS));
        }
        try {
            const tree = await this.client.getAccessibility();
            return {
                hierarchy: JSON.stringify(loupeToHierarchy(tree)),
                settleDurationMs: Date.now() - started,
            };
        } catch (err) {
            console.error('[LoupeDriver] /accessibility failed after settle, falling back:', err);
            return this.wrapper.dumpHierarchyUntilSettled(settleTimeoutMs);
        }
    }

    createTreeReader(): TreeHierarchyReader {
        return async () => {
            if (!this.canUseLoupe()) {
                const raw = await this.wrapper.dumpHierarchyLite();
                return HierarchyParser.parse(raw);
            }
            try {
                const tree = await this.client.getAccessibility();
                return loupeToHierarchy(tree);
            } catch (err) {
                console.error('[LoupeDriver] tree reader fell back to Maestro:', err);
                const raw = await this.wrapper.dumpHierarchyLite();
                return HierarchyParser.parse(raw);
            }
        };
    }

    // ── Actions ──

    async executeAction(
        action: UIActionType,
        element: UIElement,
        textInput?: string,
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.canUseLoupe()) {
            return this.wrapper.executeAction(action, element, textInput);
        }

        try {
            switch (action) {
                case 'tap':
                    return await this.dispatchTap(element);
                case 'type':
                case 'inputText':
                    if (!textInput) {
                        return { success: false, error: 'inputText requires textInput' };
                    }
                    if (element.id || element.accessibilityLabel || element.text || element.bounds) {
                        // Focus first via tap, then dispatch the text payload.
                        const focus = await this.dispatchTap(element);
                        if (!focus.success) return focus;
                    }
                    await this.client.typeText(textInput);
                    return { success: true };
                // back / scroll / swipe / assertVisible: delegate to wrapper so
                // YAML synthesized from these still matches Maestro's contract.
                case 'back':
                case 'scroll':
                case 'swipe':
                case 'scrollUntilVisible':
                case 'swipeUntilVisible':
                case 'assertVisible':
                    return this.wrapper.executeAction(action, element, textInput);
                default:
                    return { success: false, error: `Unknown UIActionType: ${action}` };
            }
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Selector priority matches synthesis (`src/synthesis/generator.ts`):
     *   id → accessibilityLabel (resolved via cached /observation) → bounds/point.
     * This is load-bearing for output convergence — replaying the YAML must hit
     * the same target the LoupeDriver hit live.
     */
    private async dispatchTap(element: UIElement): Promise<{ success: boolean; error?: string }> {
        if (element.id) {
            await this.client.tapByTestId(element.id);
            return { success: true };
        }
        if (element.accessibilityLabel || element.text) {
            const ref = await this.findRef(element);
            if (ref) {
                await this.client.tapByRef(ref);
                return { success: true };
            }
        }
        const point = element.point ?? centerOf(element.bounds);
        if (point) {
            await this.client.tapAtPoint(point.x, point.y);
            return { success: true };
        }
        return {
            success: false,
            error: 'tap requires element.id, element.accessibilityLabel, element.text, or element.bounds/point',
        };
    }

    private async findRef(element: UIElement): Promise<string | undefined> {
        const obs = this.lastObservation ?? (await this.refreshObservation());
        if (!obs?.interactive) return undefined;
        const want = element.accessibilityLabel || element.text;
        const wantText = element.text;
        for (const e of obs.interactive) {
            if (element.id && e.testID === element.id) return e.ref;
            if (want && (e.text === want || e.testID === want)) return e.ref;
            if (wantText && e.text === wantText) return e.ref;
        }
        return undefined;
    }

    private async refreshObservation(): Promise<LoupeCompactObservation | undefined> {
        try {
            const obs = await this.client.getObservation();
            this.lastObservation = obs;
            return obs;
        } catch (err) {
            console.error('[LoupeDriver] /observation refresh failed:', err);
            return undefined;
        }
    }

    private canUseLoupe(): boolean {
        return this.injected && !this.degraded;
    }

    // ── Delegated to wrapper (Maestro semantics required for output convergence) ──

    async runTest(
        yamlPath: string,
        env?: Record<string, string>,
        debugOutput?: string,
        signal?: AbortSignal,
        onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ): Promise<{ passed: boolean; output: string; durationMs: number }> {
        return this.wrapper.runTest(yamlPath, env, debugOutput, signal, onLine);
    }

    async validateSetup(): Promise<void> {
        return this.wrapper.validateSetup();
    }

    async validateSimulator(
        platform: MobilePlatform,
    ): Promise<{ booted: boolean; deviceId?: string }> {
        return this.wrapper.validateSimulator(platform);
    }

    async uninstallDriver(platform: MobilePlatform, deviceId?: string): Promise<void> {
        return this.wrapper.uninstallDriver(platform, deviceId);
    }

    async ensureCleanDriverState(
        platform: MobilePlatform,
        deviceId?: string,
        options?: { force?: boolean; probeTimeoutMs?: number },
    ): Promise<void> {
        return this.wrapper.ensureCleanDriverState(platform, deviceId, options);
    }
}

function centerOf(
    bounds: { x: number; y: number; width: number; height: number } | undefined,
): { x: number; y: number } | undefined {
    if (!bounds) return undefined;
    return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
    };
}

/**
 * Cheap structural fingerprint over a /observation payload. Used by
 * `dumpHierarchyUntilSettled` — two consecutive identical fingerprints mean
 * the UI has settled.
 */
function fingerprintObservation(obs: LoupeCompactObservation): string {
    const parts: string[] = [obs.snapshotID ?? '', obs.screen ?? ''];
    for (const e of obs.interactive ?? []) {
        parts.push(`${e.ref}|${e.testID ?? ''}|${e.text ?? ''}|${e.role ?? ''}`);
    }
    return parts.join('\n');
}
