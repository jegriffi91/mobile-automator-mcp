/**
 * NetworkMatcher — declarative predicate for filtering/identifying network events.
 *
 * Used by every `verify_network_*` tool. All fields are optional and ANDed
 * together; an empty matcher matches every event.
 */

import type { NetworkEvent } from '../types.js';

export interface NetworkMatcher {
    /** Substring match on `event.url` */
    pathContains?: string;
    /** Regex string; matched against the extracted GraphQL operationName
     *  first, then falls back to the raw `requestBody` if parsing fails. */
    operationMatches?: string;
    /** Exact match on `event.statusCode` */
    statusCode?: number;
    /** Substring match on `event.responseBody` */
    bodyContains?: string;
    /** Substring match on `event.requestBody` */
    requestBodyContains?: string;
    /** Exact match on `event.method` (case-insensitive) */
    method?: string;
}

/**
 * Extract a GraphQL `operationName` from a JSON request body.
 * Returns `undefined` for non-JSON bodies or bodies without `operationName`.
 */
export function extractOperationName(body?: string): string | undefined {
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && typeof parsed.operationName === 'string') {
            return parsed.operationName;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

/** Lazily compile regex; invalid patterns throw at match time. */
function compileRegex(pattern: string): RegExp {
    return new RegExp(pattern);
}

export function matchEvent(event: NetworkEvent, matcher: NetworkMatcher): boolean {
    if (matcher.pathContains && !event.url.includes(matcher.pathContains)) {
        return false;
    }
    if (matcher.statusCode !== undefined && event.statusCode !== matcher.statusCode) {
        return false;
    }
    if (matcher.bodyContains && !(event.responseBody ?? '').includes(matcher.bodyContains)) {
        return false;
    }
    if (matcher.requestBodyContains && !(event.requestBody ?? '').includes(matcher.requestBodyContains)) {
        return false;
    }
    if (matcher.method && event.method.toUpperCase() !== matcher.method.toUpperCase()) {
        return false;
    }
    if (matcher.operationMatches) {
        const re = compileRegex(matcher.operationMatches);
        const opName = extractOperationName(event.requestBody);
        const haystack = opName ?? event.requestBody ?? '';
        if (!re.test(haystack)) {
            return false;
        }
    }
    return true;
}

export function filterEvents(events: NetworkEvent[], matcher: NetworkMatcher): NetworkEvent[] {
    return events.filter((e) => matchEvent(e, matcher));
}

export function findFirstMatch(
    events: NetworkEvent[],
    matcher: NetworkMatcher,
): NetworkEvent | undefined {
    return events.find((e) => matchEvent(e, matcher));
}

/** Human-readable summary of a matcher (for error messages). */
export function describeMatcher(matcher: NetworkMatcher): string {
    const parts: string[] = [];
    if (matcher.method) parts.push(`method=${matcher.method}`);
    if (matcher.pathContains) parts.push(`path~"${matcher.pathContains}"`);
    if (matcher.operationMatches) parts.push(`op~/${matcher.operationMatches}/`);
    if (matcher.statusCode !== undefined) parts.push(`status=${matcher.statusCode}`);
    if (matcher.bodyContains) parts.push(`body~"${matcher.bodyContains}"`);
    if (matcher.requestBodyContains) parts.push(`req~"${matcher.requestBodyContains}"`);
    return parts.length ? parts.join(' ') : '<empty matcher>';
}
