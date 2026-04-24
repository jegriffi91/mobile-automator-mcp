export { getMergedEvents } from './event-source.js';
export type { EventSourceOptions, MergedEventsResult } from './event-source.js';

export {
    matchEvent,
    filterEvents,
    findFirstMatch,
    extractOperationName,
    describeMatcher,
} from './matchers.js';
export type { NetworkMatcher } from './matchers.js';

export { resolveAfterAction, eventsInWindow } from './time-window.js';
export type { AfterActionRef, ResolvedAnchor } from './time-window.js';

export { getByPath, existsAtPath } from './jsonpath.js';

export { percentile, computeDurationStats } from './percentiles.js';
export type { DurationStats } from './percentiles.js';
