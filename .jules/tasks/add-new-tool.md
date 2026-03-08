# Task: Add a New MCP Tool

Step-by-step playbook for adding a new tool to the mobile-automator-mcp server.

---

## Pre-Conditions

- [ ] You have a clear tool name, description, and input/output contract
- [ ] Read the root [AGENTS.md](../../AGENTS.md) for global constraints
- [ ] Read [Architecture Docs](../../docs/architecture.md) for module contracts

## Steps

### 1. Define Schemas (`src/schemas.ts`)

Add Zod input and output schemas for the new tool:

```typescript
export const MyNewToolInputSchema = z.object({
    sessionId: z.string().describe('...'),
    // ...additional fields
});

export const MyNewToolOutputSchema = z.object({
    // ...output fields
});
```

Derive TypeScript types at the bottom of the file:

```typescript
export type MyNewToolInput = z.infer<typeof MyNewToolInputSchema>;
export type MyNewToolOutput = z.infer<typeof MyNewToolOutputSchema>;
```

Add the tool name to `TOOL_NAMES`:

```typescript
export const TOOL_NAMES = {
    // ...existing tools
    MY_NEW_TOOL: 'my_new_tool',
} as const;
```

### 2. Add Domain Types (`src/types.ts`) — if needed

Only add new interfaces here if the tool introduces new **domain entities** (e.g. a new kind of event or element). Do NOT duplicate the Zod schema shapes.

### 3. Implement Handler (`src/handlers.ts`)

Add a new handler function following the existing pattern:

```typescript
export async function handleMyNewTool(
    input: MyNewToolInput
): Promise<MyNewToolOutput> {
    // Delegate to the appropriate submodule
}
```

### 4. Register Tool (`src/index.ts`)

Register the tool with the MCP server:

```typescript
server.registerTool(
    TOOL_NAMES.MY_NEW_TOOL,
    {
        title: 'My New Tool',
        description: '...',
        inputSchema: MyNewToolInputSchema,
        outputSchema: MyNewToolOutputSchema,
        annotations: { /* ... */ },
    },
    async (args) => {
        const result = await handleMyNewTool(args);
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
);
```

### 5. Write Tests

If the handler delegates to a new pure-logic module, create a co-located `*.test.ts` file.

### 6. Verify

- [ ] `npm run build` — compiles cleanly
- [ ] `npm test` — all tests pass
- [ ] `npm run lint` — no lint errors
