# iOS Accuracy + Token-Budget Test Bed

Measures the current hierarchy compactor against four pillars so any future
"spatial semantic compactor" PR has a concrete bar to clear.

## What it measures

| Pillar | Always on | Blocks exit code | Source of truth |
|---|---|---|---|
| 1 — Spatial-tag correctness | yes | yes | bed-internal geometry + hand-labeled audit |
| 2 — Element-selection accuracy | no (`--with-llm`) | only when `--with-llm` | `claude -p` JSON pick |
| 3 — Token budget compliance | yes (heuristic) | yes | char heuristic always; `usage.input_tokens` when `--with-llm` |
| 4 — Compaction ratio | yes | no (informational) | raw bytes / compacted bytes |

The "compactor under test" today is the existing
`HierarchyParser.filterInteractive + HierarchyParser.compact` pipeline. When
the real spatial compactor lands it swaps in behind the same interface and
this bed verifies it doesn't regress.

## Running

```bash
# Pillars 1, 3 (heuristic), 4 only — fast, no LLM cost.
npm run test:bed

# All four pillars — uses `claude -p` for selection and ground-truth tokens.
npm run test:bed -- --with-llm

# Other flags
npm run test:bed -- --device-id <UDID> --app-id <bundle> --filter screen=home
```

Requirements:
- macOS with a booted iOS simulator.
- Maestro CLI on `PATH` (or `MAESTRO_CLI_PATH` set).
- The target app installed on the simulator.
- For `--with-llm`: the `claude` CLI on `PATH` and already authenticated.

The bed **never** reads `ANTHROPIC_API_KEY`. All LLM access goes through
`claude -p`, which uses whatever auth your Claude Code config already has.

## Reports

Each run writes `tests/bed/reports/<ISO>.json`. The directory is
`.gitignore`'d except for `baseline.json` — the one committed snapshot used as
the comparison point for future PRs.

**Promoting a new baseline** is a manual two-step:
```bash
cp tests/bed/reports/<ISO>.json tests/bed/reports/baseline.json
git add tests/bed/reports/baseline.json && git commit
```

## Authoring the verification flow

`flows/ios-bed-verification.yaml` is a small linear flow of driver actions
with named `checkpoint:` markers. At each checkpoint the bed dumps the live
hierarchy and runs all four pillars. Add screens by extending `steps:`.

## Authoring the task corpus

`corpus/tasks.yaml` carries `(screen, natural-language goal, expected element
id)` tuples. Aim for ~10 per screen — at 50 total, 2 misses = 96% and 4
misses = 92%, which lines up directly with the per-screen and corpus
thresholds.

`corpus/spatial-truth.yaml` is the small hand-labeled audit: 3–5 elements per
screen with their expected 3x3 grid label, asserted at 100%. Catches bugs in
the bed's own spatial formula that would otherwise invisibly pass the
self-consistency check.

## Not part of this bed

- The spatial compactor itself — built in a later PR.
- The `get_screen_state` MCP tool — also later.
- Android coverage — iOS-only by mandate.
- Production-app testing — internal scenarios only.
