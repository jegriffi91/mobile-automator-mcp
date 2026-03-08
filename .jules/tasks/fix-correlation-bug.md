# Task: Fix a Correlation Bug

Scoped task for debugging and fixing issues in the timestamp-based correlator.

---

## Context

The correlator (`src/synthesis/correlator.ts`) matches UI interactions to network events using a sliding time window. Bugs typically manifest as:

- Network events attached to the wrong UI action
- Network events dropped (not correlated to any action)
- Duplicate correlations

## Steps

### 1. Reproduce

Read the existing tests in `src/synthesis/correlator.test.ts`. Add a new `it()` block that reproduces the bug with concrete timestamps:

```typescript
it('should handle <describe the bug scenario>', () => {
    const interactions: UIInteraction[] = [ /* ... */ ];
    const networkEvents: NetworkEvent[] = [ /* ... */ ];
    
    const result = correlator.correlate(interactions, networkEvents);
    
    // This assertion should FAIL before the fix
    expect(result[0].networkCaptures).toHaveLength(1);
});
```

### 2. Run the Failing Test

```bash
npm test
```

Confirm the new test fails as expected.

### 3. Fix the Correlator

Edit `src/synthesis/correlator.ts`. Key areas to check:

- The time window comparison: `event.timestamp - action.timestamp <= windowMs`
- The sorting of events by timestamp before correlation
- The early-break optimization (previously had a bug — ensure events after the window are not skipped prematurely if later events could match)

### 4. Verify

- [ ] `npm test` — the new test now passes, and all existing tests still pass
- [ ] `npm run build` — compiles cleanly

### 5. Reference

- Module rules: [`src/synthesis/AGENTS.md`](../../src/synthesis/AGENTS.md)
- Testing patterns: [`docs/testing-strategy.md`](../../docs/testing-strategy.md)
