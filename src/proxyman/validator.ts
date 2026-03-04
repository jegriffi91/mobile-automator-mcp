/**
 * PayloadValidator — Deep-compare SDUI response payloads against expectations.
 *
 * Recursively walks the `expected` object and reports dot-path mismatches
 * (e.g., "data.sections[0].title: expected 'Home' but got 'Dashboard'").
 */

export class PayloadValidator {
    /**
     * Validate that a response payload contains all expected fields/values.
     *
     * @param actual - The parsed response body from Proxyman
     * @param expected - Key-value pairs that must be present
     * @returns matched status + list of human-readable mismatch descriptions
     */
    static validate(
        actual: Record<string, unknown>,
        expected: Record<string, unknown>
    ): { matched: boolean; mismatches: string[] } {
        const mismatches: string[] = [];
        PayloadValidator.compareDeep(actual, expected, '', mismatches);

        return {
            matched: mismatches.length === 0,
            mismatches,
        };
    }

    private static compareDeep(
        actual: unknown,
        expected: unknown,
        path: string,
        mismatches: string[]
    ): void {
        // If expected is null/undefined, just check presence
        if (expected === null || expected === undefined) {
            return;
        }

        // Handle missing actual
        if (actual === null || actual === undefined) {
            mismatches.push(`${path || '<root>'}: expected value but got ${actual}`);
            return;
        }

        // Primitive comparison
        if (typeof expected !== 'object') {
            if (actual !== expected) {
                mismatches.push(
                    `${path || '<root>'}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
                );
            }
            return;
        }

        // Array comparison
        if (Array.isArray(expected)) {
            if (!Array.isArray(actual)) {
                mismatches.push(`${path || '<root>'}: expected array but got ${typeof actual}`);
                return;
            }
            for (let i = 0; i < expected.length; i++) {
                if (i >= (actual as unknown[]).length) {
                    mismatches.push(`${path}[${i}]: expected element but array too short (length ${(actual as unknown[]).length})`);
                    continue;
                }
                PayloadValidator.compareDeep(
                    (actual as unknown[])[i],
                    expected[i],
                    `${path}[${i}]`,
                    mismatches
                );
            }
            // Flag extra elements in actual that aren't in expected
            if ((actual as unknown[]).length > expected.length) {
                mismatches.push(
                    `${path || '<root>'}: actual array has ${(actual as unknown[]).length} elements but only ${expected.length} expected`
                );
            }
            return;
        }

        // Object comparison — walk expected keys only
        if (typeof actual !== 'object' || Array.isArray(actual)) {
            mismatches.push(`${path || '<root>'}: expected object but got ${typeof actual}`);
            return;
        }

        for (const key of Object.keys(expected as Record<string, unknown>)) {
            const childPath = path ? `${path}.${key}` : key;
            const actualObj = actual as Record<string, unknown>;
            const expectedObj = expected as Record<string, unknown>;

            if (!(key in actualObj)) {
                mismatches.push(`${childPath}: key missing in actual response`);
                continue;
            }

            PayloadValidator.compareDeep(actualObj[key], expectedObj[key], childPath, mismatches);
        }
    }
}
