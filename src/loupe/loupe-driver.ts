/**
 * LoupeDriver — AutomationDriver backed by Loupe's in-process HTTP server.
 *
 * All live UI actions (tap, type, swipe, scroll, back, scrollUntilVisible,
 * swipeUntilVisible, assertVisible) route through the Loupe runtime so the
 * Maestro XCUITest / WebDriverAgent driver is bypassed entirely during
 * recording. Only `runTest`, `validateSetup`, `validateSimulator`,
 * `ensureCleanDriverState`, and `uninstallDriver` delegate to MaestroWrapper —
 * these manage the Maestro CLI / Maestro driver itself, which the synthesized
 * YAML will need at replay time.
 *
 * Composition of higher-level gestures (Loupe only ships `tap`, `swipe`,
 * `type`):
 *   • `back`         → left-edge swipe (iOS pop gesture)
 *   • `scroll`       → vertical swipe through screen midline
 *   • `swipe`        → vertical swipe (DOWN, matching Maestro's default)
 *   • `scrollUntilVisible` → loop { check accessibility tree → swipe DOWN }
 *   • `swipeUntilVisible`  → loop { check accessibility tree → swipe RIGHT }
 *   • `assertVisible`      → query accessibility tree
 *
 * Lifecycle:
 *   • `start(deviceId)` stores UDID; if `bundleId` was passed to the
 *     constructor, eagerly injects via `setAppContext(bundleId)`.
 *   • `setAppContext(bundleId)` (idempotent) spawns `loupe start` and waits
 *     for `/runtime` to become healthy. On failure, marks the driver
 *     `degraded` — every later hierarchy/action call delegates to the
 *     internal wrapper.
 *
 * Failure model: Loupe never throws into handlers. Injection failure ⇒
 * degraded mode (everything routes to wrapper). HTTP errors on hierarchy
 * reads fall back to wrapper per-call. CLI errors on actions surface as
 * `{ success: false, error }` — they do NOT silently fall back to wrapper
 * because that would defeat the point of the integration.
 */

import { LoupeClient, type LoupeCompactObservation } from './client.js';
import { loupeToHierarchy, type LoupeAccessibilityNode } from './hierarchy.js';
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
const SCROLL_UNTIL_VISIBLE_MAX_STEPS = 10;
const SCROLL_UNTIL_VISIBLE_PAUSE_MS = 300;

// Reasonable iPhone 14 dimensions used only when the accessibility root frame
// is missing. Replaced by the live root frame on first successful read.
const DEFAULT_SCREEN = { width: 393, height: 852 };

interface ScreenSize {
    width: number;
    height: number;
}

export class LoupeDriver implements AutomationDriver {
    private readonly wrapper: MaestroWrapper;
    private readonly client: LoupeClient;
    private deviceId?: string;
    private bundleId?: string;
    private injected = false;
    private degraded = false;
    /** Cached observation used to resolve element → ref lookups for taps. */
    private lastObservation?: LoupeCompactObservation;
    /** Cached screen size, refreshed opportunistically from accessibility reads. */
    private screenSize: ScreenSize = DEFAULT_SCREEN;

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
            // Opportunistically prime the screen-size cache from the live root frame.
            this.refreshScreenSize().catch(() => {});
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
            this.cacheScreenSizeFromTree(tree);
            return JSON.stringify(loupeToHierarchy(tree));
        } catch (err) {
            console.error('[LoupeDriver] /accessibility failed, falling back to Maestro:', err);
            return this.wrapper.dumpHierarchy();
        }
    }

    async dumpHierarchyLite(): Promise<string> {
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
            this.cacheScreenSizeFromTree(tree);
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
                this.cacheScreenSizeFromTree(tree);
                return loupeToHierarchy(tree);
            } catch (err) {
                console.error('[LoupeDriver] tree reader fell back to Maestro:', err);
                const raw = await this.wrapper.dumpHierarchyLite();
                return HierarchyParser.parse(raw);
            }
        };
    }

    // ── Actions (every live primitive routes through Loupe) ──

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
                    if (element.id || element.accessibilityLabel || element.text || element.bounds || element.point) {
                        const focus = await this.dispatchTap(element);
                        if (!focus.success) return focus;
                    }
                    await this.client.typeText(textInput);
                    return { success: true };

                case 'back':
                    return await this.dispatchBack();

                case 'swipe':
                case 'scroll':
                    return await this.dispatchScroll('down');

                case 'scrollUntilVisible':
                    return await this.dispatchScrollUntilVisible(element, 'down');

                case 'swipeUntilVisible':
                    return await this.dispatchScrollUntilVisible(element, 'right');

                case 'assertVisible':
                    return await this.dispatchAssertVisible(element);

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
            this.lastObservation = undefined; // invalidate — UI likely changed
            return { success: true };
        }
        if (element.accessibilityLabel || element.text) {
            const ref = await this.findRef(element);
            if (ref) {
                await this.client.tapByRef(ref);
                this.lastObservation = undefined;
                return { success: true };
            }
        }
        const point = element.point ?? centerOf(element.bounds);
        if (point) {
            await this.client.tapAtPoint(point.x, point.y);
            this.lastObservation = undefined;
            return { success: true };
        }
        return {
            success: false,
            error: 'tap requires element.id, element.accessibilityLabel, element.text, or element.bounds/point',
        };
    }

    /**
     * iOS "back" is the left-edge swipe gesture (interactive pop). Swipe from
     * x=0 to roughly half the screen width at vertical midpoint.
     */
    private async dispatchBack(): Promise<{ success: boolean; error?: string }> {
        const { width, height } = this.screenSize;
        const midY = height / 2;
        await this.client.swipe(0, midY, width * 0.55, midY);
        this.lastObservation = undefined;
        return { success: true };
    }

    /**
     * Vertical or horizontal swipe through the screen midline. `direction`
     * follows Maestro's convention — `down` matches the YAML `direction: DOWN`
     * that synthesized `swipe`/`scroll` emits.
     */
    private async dispatchScroll(
        direction: 'down' | 'up' | 'right' | 'left',
    ): Promise<{ success: boolean; error?: string }> {
        const { width, height } = this.screenSize;
        const cx = width / 2;
        const cy = height / 2;
        let fromX: number, fromY: number, toX: number, toY: number;
        switch (direction) {
            case 'down':
                fromX = cx; fromY = height * 0.25; toX = cx; toY = height * 0.75; break;
            case 'up':
                fromX = cx; fromY = height * 0.75; toX = cx; toY = height * 0.25; break;
            case 'right':
                fromX = width * 0.25; fromY = cy; toX = width * 0.75; toY = cy; break;
            case 'left':
                fromX = width * 0.75; fromY = cy; toX = width * 0.25; toY = cy; break;
        }
        await this.client.swipe(fromX, fromY, toX, toY);
        this.lastObservation = undefined;
        return { success: true };
    }

    private async dispatchScrollUntilVisible(
        element: UIElement,
        direction: 'down' | 'right',
    ): Promise<{ success: boolean; error?: string }> {
        for (let i = 0; i < SCROLL_UNTIL_VISIBLE_MAX_STEPS; i++) {
            const found = await this.elementVisible(element);
            if (found) return { success: true };
            await this.dispatchScroll(direction);
            await new Promise((r) => setTimeout(r, SCROLL_UNTIL_VISIBLE_PAUSE_MS));
        }
        // One last check after the final scroll.
        if (await this.elementVisible(element)) return { success: true };
        return {
            success: false,
            error: `${direction === 'right' ? 'swipeUntilVisible' : 'scrollUntilVisible'} did not reveal the target after ${SCROLL_UNTIL_VISIBLE_MAX_STEPS} swipes`,
        };
    }

    private async dispatchAssertVisible(element: UIElement): Promise<{ success: boolean; error?: string }> {
        const found = await this.elementVisible(element);
        return found
            ? { success: true }
            : {
                  success: false,
                  error: `assertVisible failed: no node matched ${describeSelector(element)}`,
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

    /**
     * Scan the live accessibility tree for a node matching the selector
     * (id → accessibilityLabel → text). Used by scrollUntilVisible /
     * swipeUntilVisible / assertVisible. Visibility is enforced upstream by
     * `shouldInclude` in Loupe and re-checked in `loupeToHierarchy`.
     */
    private async elementVisible(element: UIElement): Promise<boolean> {
        let tree;
        try {
            tree = await this.client.getAccessibility();
        } catch {
            return false;
        }
        this.cacheScreenSizeFromTree(tree);
        for (const node of Object.values(tree.nodes)) {
            if (matchesSelector(node, element)) return true;
        }
        return false;
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

    private async refreshScreenSize(): Promise<void> {
        try {
            const tree = await this.client.getAccessibility();
            this.cacheScreenSizeFromTree(tree);
        } catch {
            /* keep cached defaults */
        }
    }

    private cacheScreenSizeFromTree(tree: { rootRefs: string[]; nodes: Record<string, LoupeAccessibilityNode> }): void {
        const rootRef = tree.rootRefs?.[0];
        if (!rootRef) return;
        const root = tree.nodes[rootRef];
        const f = root?.frame;
        if (f && f.width > 0 && f.height > 0) {
            this.screenSize = { width: f.width, height: f.height };
        }
    }

    private canUseLoupe(): boolean {
        return this.injected && !this.degraded;
    }

    // ── Delegated to wrapper (Maestro CLI is the source of truth for these) ──

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

function fingerprintObservation(obs: LoupeCompactObservation): string {
    const parts: string[] = [obs.snapshotID ?? '', obs.screen ?? ''];
    for (const e of obs.interactive ?? []) {
        parts.push(`${e.ref}|${e.testID ?? ''}|${e.text ?? ''}|${e.role ?? ''}`);
    }
    return parts.join('\n');
}

function matchesSelector(node: LoupeAccessibilityNode, sel: UIElement): boolean {
    if (node.isVisible === false) return false;
    const nodeId = node.testID ?? node.identifier;
    if (sel.id) return nodeId === sel.id;
    if (sel.accessibilityLabel) return node.label === sel.accessibilityLabel;
    if (sel.text) {
        return node.value === sel.text || node.text === sel.text || node.placeholder === sel.text;
    }
    return false;
}

function describeSelector(el: UIElement): string {
    if (el.id) return `id="${el.id}"`;
    if (el.accessibilityLabel) return `label="${el.accessibilityLabel}"`;
    if (el.text) return `text="${el.text}"`;
    return '<no selector>';
}
