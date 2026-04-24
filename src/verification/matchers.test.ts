import { describe, it, expect } from 'vitest';
import {
    matchEvent,
    filterEvents,
    findFirstMatch,
    extractOperationName,
    describeMatcher,
} from './matchers.js';
import type { NetworkEvent } from '../types.js';

function makeEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
    return {
        sessionId: 's1',
        timestamp: '2024-01-01T00:00:00.000Z',
        method: 'GET',
        url: 'https://api.example.com/graphql',
        statusCode: 200,
        ...overrides,
    };
}

describe('matchEvent', () => {
    it('matches pathContains as substring of URL', () => {
        const e = makeEvent({ url: 'https://api.example.com/graphql?q=1' });
        expect(matchEvent(e, { pathContains: '/graphql' })).toBe(true);
        expect(matchEvent(e, { pathContains: '/rest' })).toBe(false);
    });

    it('matches statusCode exactly', () => {
        expect(matchEvent(makeEvent({ statusCode: 500 }), { statusCode: 500 })).toBe(true);
        expect(matchEvent(makeEvent({ statusCode: 500 }), { statusCode: 200 })).toBe(false);
    });

    it('matches bodyContains against responseBody, treating missing body as empty', () => {
        expect(matchEvent(makeEvent({ responseBody: 'abc XYZ def' }), { bodyContains: 'XYZ' })).toBe(true);
        expect(matchEvent(makeEvent(), { bodyContains: 'XYZ' })).toBe(false);
    });

    it('matches method case-insensitively', () => {
        expect(matchEvent(makeEvent({ method: 'POST' }), { method: 'post' })).toBe(true);
    });

    it('matches operationMatches against extracted GraphQL operationName', () => {
        const e = makeEvent({
            requestBody: JSON.stringify({ operationName: 'SduiAsset', variables: {} }),
        });
        expect(matchEvent(e, { operationMatches: '^Sdui' })).toBe(true);
        expect(matchEvent(e, { operationMatches: '^Other' })).toBe(false);
    });

    it('falls back to raw requestBody when operationName is absent', () => {
        const e = makeEvent({ requestBody: 'query { foo { bar } }' });
        expect(matchEvent(e, { operationMatches: 'foo' })).toBe(true);
    });

    it('treats missing requestBody as empty string for operationMatches', () => {
        const e = makeEvent();
        expect(matchEvent(e, { operationMatches: 'anything' })).toBe(false);
    });

    it('ANDs multiple matcher fields together', () => {
        const e = makeEvent({ statusCode: 500, url: 'https://api.example.com/graphql' });
        expect(matchEvent(e, { pathContains: '/graphql', statusCode: 500 })).toBe(true);
        expect(matchEvent(e, { pathContains: '/graphql', statusCode: 200 })).toBe(false);
    });

    it('matches every event with an empty matcher', () => {
        expect(matchEvent(makeEvent(), {})).toBe(true);
    });
});

describe('filterEvents / findFirstMatch', () => {
    const events = [
        makeEvent({ url: 'https://api.example.com/a', statusCode: 200 }),
        makeEvent({ url: 'https://api.example.com/b', statusCode: 500 }),
        makeEvent({ url: 'https://api.example.com/c', statusCode: 500 }),
    ];

    it('filterEvents returns only matching events', () => {
        expect(filterEvents(events, { statusCode: 500 })).toHaveLength(2);
    });

    it('findFirstMatch returns the first matching event', () => {
        const hit = findFirstMatch(events, { statusCode: 500 });
        expect(hit?.url).toBe('https://api.example.com/b');
    });

    it('findFirstMatch returns undefined when nothing matches', () => {
        expect(findFirstMatch(events, { statusCode: 404 })).toBeUndefined();
    });
});

describe('extractOperationName', () => {
    it('returns the operationName field from a GraphQL JSON body', () => {
        expect(extractOperationName(JSON.stringify({ operationName: 'Foo' }))).toBe('Foo');
    });

    it('returns undefined for non-JSON bodies', () => {
        expect(extractOperationName('query { foo }')).toBeUndefined();
    });

    it('returns undefined for undefined bodies', () => {
        expect(extractOperationName(undefined)).toBeUndefined();
    });

    it('returns undefined when the field is missing', () => {
        expect(extractOperationName(JSON.stringify({ query: '...' }))).toBeUndefined();
    });

    it('returns undefined when operationName is not a string', () => {
        expect(extractOperationName(JSON.stringify({ operationName: 42 }))).toBeUndefined();
    });
});

describe('describeMatcher', () => {
    it('describes an empty matcher', () => {
        expect(describeMatcher({})).toBe('<empty matcher>');
    });

    it('joins multiple fields', () => {
        const desc = describeMatcher({ pathContains: '/graphql', statusCode: 500 });
        expect(desc).toContain('/graphql');
        expect(desc).toContain('500');
    });
});
