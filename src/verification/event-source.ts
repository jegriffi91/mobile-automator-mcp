/**
 * Shared network event fetcher for verification tools.
 *
 * Merges Proxyman HAR entries with session-DB-logged events, deduplicates by
 * `url|timestamp`, and time-scopes Proxyman events to the session's start.
 *
 * Every `verify_network_*` tool routes through this helper so the scoping rule
 * is enforced in one place — forgetting it elsewhere would leak prior-session
 * traffic into assertions.
 */

import { sessionManager } from '../session/index.js';
import { proxymanWrapper } from '../proxyman/index.js';
import type { NetworkEvent } from '../types.js';

export interface EventSourceOptions {
    /** Optional domain list passed to Proxyman for pre-filtering */
    filterDomains?: string[];
    /** Optional URL substring; applied to both Proxyman and DB events */
    filterPath?: string;
}

export interface MergedEventsResult {
    /** Chronological, deduplicated merge of session DB + scoped Proxyman events */
    merged: NetworkEvent[];
    /** Proxyman events filtered to the session window (for callers that need to re-persist) */
    scopedProxymanEvents: NetworkEvent[];
}

/**
 * Fetch, scope, merge, and deduplicate network events for a session.
 *
 * Scoping: Proxyman events with timestamps before `session.startedAt` are dropped.
 * Dedup key: `${url}|${timestamp}`.
 */
export async function getMergedEvents(
    sessionId: string,
    opts: EventSourceOptions = {},
): Promise<MergedEventsResult> {
    const session = await sessionManager.getSession(sessionId);
    const domains = opts.filterDomains ?? session?.filterDomains;

    // Proxyman applies filterPath internally; don't slice by limit here (callers
    // that need a limit must apply it post-merge, after time-scoping).
    const proxymanEvents = await proxymanWrapper.getTransactions(
        sessionId,
        opts.filterPath,
        undefined,
        domains,
    );

    const sessionStart = session?.startedAt ? new Date(session.startedAt).getTime() : 0;
    const scopedProxymanEvents = sessionStart
        ? proxymanEvents.filter((e) => new Date(e.timestamp).getTime() >= sessionStart)
        : proxymanEvents;

    let dbEvents = await sessionManager.getNetworkEvents(sessionId);
    if (opts.filterPath) {
        dbEvents = dbEvents.filter((e) => e.url.includes(opts.filterPath!));
    }

    const seen = new Set<string>();
    const merged: NetworkEvent[] = [];
    for (const event of [...dbEvents, ...scopedProxymanEvents]) {
        const key = `${event.url}|${event.timestamp}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(event);
        }
    }

    return { merged, scopedProxymanEvents };
}
