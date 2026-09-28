# pi-jev-model-router

A pi extension that routes every prompt to a model tier using **TypeSafe Jev**
(System One) typed judgments. You type normally; before the turn starts, Jev
reads the request and answers four narrow questions, code composes those into a
tier, applies your budget policy, and pi switches to the matching model.

```
you type a prompt
        │
        ▼
   Jev (one request, 4 parallel questions)
     • task_kind            choice: plan / implement / debug / refactor / review / research / explain / operate / write / chat
     • complexity           score:  trivial → architectural
     • capability_deserved  score:  minimal → maximum (price ignored)
     • needs_deep_reasoning noul:   yes/no probability
        │
        ▼
   code composes the decision
     demand = 0.55·complexity + 0.45·capability (+ reasoning nudge)
     demand = max(demand, kind floor)          # planning/review never go cheap
     confidence guard → budget guard → availability guard → cache guard
        │
        ▼
   pi.setModel(node) + pi.setThinkingLevel(node)  → the turn runs on that model
```

The split is deliberate: **Jev judges the task, code owns the budget.** Changing
your spend caps never invalidates the judgment, and the judgment stays a pure
semantic read of the request.

## What you see

**In the transcript.** Every decision is written as a durable entry, so you can
always see which model the request went to and why:

```
jev-router → high  openai/gpt-5.3-codex
implement · complexity 1.70/3 · capability 1.55/3 · reasoning 0.82 → high
· budget 12% of cap → one tier down
```

Expand the entry (same key as other collapsible content) to see the raw judgment:
kind and its confidence, complexity, capability deserved, deep-reasoning
probability, composed demand score, and budget pressure.

The glyph encodes the action: `→` switched, `=` already active (stickiness),
`•` notify-only mode, `×` skipped (kept current / unavailable). Entries are stored
in the session but never sent to the LLM, so they cost no context.

**Not-routed prompts are shown too**, so routing is never silently absent:

```
jev-router · not routed
acknowledgement — staying on the current model
using openrouter/~anthropic/claude-opus-latest
```

A prompt is left on the current model for a clear reason: it is an
acknowledgement (`yes`, `continue`, …), a short continuation inside an ongoing
conversation, or no configured route is available. A short *first* message in a
fresh session (like `hi`) is a real request and **does** get routed. Duplicate
skip entries for the same reason and model are collapsed.

**In the status bar.** `jev-router:` followed by the active tier and session
spend, e.g. `jev-router:high · $0.42 · 12%`, `jev-router:on` before the first
route, or `jev-router:off` when disabled.

## Install / location

This extension lives at `~/.pi/agent/extensions/pi-jev-model-router/` (global, auto-discovered).
pi hot-reloads it with `/reload` after edits.

It needs a TypeSafe API key:

```sh
export TYPESAFE_API_KEY=...
```

## Commands

| Command | What it does |
| --- | --- |
| `/jev-router` | Status: mode, spend, routes, kind specialists, last decision |
| `/jev-router on` / `off` | Enable/disable routing |
| `/jev-router mode auto\|confirm\|notify` | `auto` switches silently; `confirm` asks each turn; `notify` only tells you |
| `/jev-router budget daily 10` | Session-only daily cap (persist it in the config file) |
| `/jev-router budget monthly 150` | Session-only monthly cap |
| `/jev-router why` | Re-run Jev on the last prompt and show the full judgment + decision trace |
| `/jev-router revert` | Switch back to the model that was active before the last auto-switch |
| `/jev-route <text>` | Classify arbitrary text and show the recommendation without switching |

The LLM can also call the `jev_route` tool to ask for a tier recommendation for
a subtask.

## Configuration

Optional. Create `~/.pi/agent/pi-jev-model-router.json`
(see `pi-jev-model-router.example.json`), or `<project>/.pi/pi-jev-model-router.json` for
project-specific routes. Later sources win: defaults → global → project → env
(`JEV_ROUTER_MODE`, `JEV_ROUTER_OFF=1`).

```json
{
  "enabled": true,
  "mode": "auto",
  "confidenceThreshold": 0.34,
  "stickiness": true,
  "budget": { "dailyUsd": 5, "monthlyUsd": 100, "softRatio": 0.7, "hardRatio": 0.9 },
  "routes": {
    "quick":    [{ "provider": "openrouter", "model": "~google/gemini-flash-latest", "thinkingLevel": "off" }],
    "standard": [{ "provider": "openrouter", "model": "~deepseek/deepseek-pro-latest" }],
    "high":     [{ "provider": "openrouter", "model": "openai/gpt-5.5" }],
    "premium":  [{ "provider": "openrouter", "model": "~anthropic/claude-opus-latest" }]
  },
  "kindModels": {
    "implement": [{ "provider": "openrouter", "model": "openai/gpt-5.3-codex", "minTier": "standard" }]
  },
  "kindMinimumTier": { "plan": "high", "review": "high", "implement": "standard" },
  "free": {
    "enabled": false,
    "policy": "prefer",
    "pool": [{ "provider": "opencode-go", "model": "space-bunny-free", "thinkingLevel": "medium" }]
  }
}
```

### Two axes of routing

1. **Tier** (`quick` → `standard` → `high` → `premium`) is the *budget axis*. Each
   tier is an ordered **candidate chain**; the first model that is available and
   authenticated wins, so you get automatic fallback when a model is down or
   your key can't afford it.
2. **`kindModels`** is the *task axis*. A kind-specialist chain is tried before
   the generic tier chain, filtered by `minTier`. Eligible specialists are ranked
   by `priority` (default `0`, higher first), then by how close their `minTier`
   is to the chosen tier, so a cheap specialist never wins a premium-quality turn
   unless you rank it up. This is how planning can land on a strong reasoner
   while implementation lands on a coding specialist.

Rules of thumb baked into the defaults:

- planning / review → strong long-horizon models, floored at `high`
- implement / debug / refactor → Codex-style coding specialists, floored at `standard`
- explain / chat / write → cheap fast models
- research → long-context readers

### Budget behaviour

`spend pressure = max(today ÷ dailyUsd, month ÷ monthlyUsd)`.

- `pressure ≥ softRatio` → drop one tier
- `pressure ≥ hardRatio` → force `quick`, unless the demand score is ≥ 2.5
  (clearly architectural), which is allowed to stay at `standard`

Spend is accumulated from each assistant message's computed cost into
`~/.pi/agent/pi-jev-model-router-state.json`, alongside Jev request counts.

### Prompt-cache awareness

Caches are per-model, so any switch makes the next request re-read the whole
prefix at full input price — cache reads are only ~10% of input, so one switch
costs roughly the entire context once, on every provider. The router gates
switches instead of making them freely:

- `maxPenaltyUsd` — estimated miss (`contextTokens × new input rate − cached
  rate`) above this blocks the switch
- `deadband` — demand must clear the current tier's band (`tier ± 0.5`) by this
  much before a tier change happens, so boundary-hovering prompts stop flapping
- `bypassTierDelta` — a jump this large still switches (genuine capability change)
- same-tier specialist swaps are priced identically, since they are still model
  changes

Set `cache.aware: false` to switch unconditionally. The estimate is skipped when
pricing is unknown, so it never blocks on guesses.

### Confidence

If Jev's `task_kind` confidence is below `confidenceThreshold` and the suggested
tier is above `standard`, routing falls back to `standard` rather than spending
premium money on a guess. Low confidence on a harmless preference is not treated
as an error.

## Tuning notes

- `useDefaultModels: false` drops the built-in `routes`/`kindModels` entirely, so
  only the models in your config are used. Tiers or kinds you don't configure
  become empty and are skipped, never back-filled from the defaults.
- A model switch resets the provider prompt cache. `cache.aware` (default on)
  gates switches by their estimated cache penalty, so tune `cache.maxPenaltyUsd`
  down for more switching, or up for more stickiness. `cache.aware: false`
  restores unconditional switching.
- `stickiness: true` is the cheap version of the same idea: it avoids re-applying
  a decision when the chosen model is already active.
- Model IDs are provider-scoped; the defaults assume `openrouter`. Swap them for
  whatever providers you have configured. `/jev-router status` marks each route
  `✓`/`✗` based on what is actually available and authenticated.
- `minPromptChars` (default 12) governs when a short message counts as a
  continuation and is left alone; a short first message in a fresh session is
  still routed. `/` commands, `yes`/`continue` acknowledgements, and `!` bash
  lines are never routed.

## Files

| File | Role |
| --- | --- |
| `index.ts` | pi wiring: events, commands, `jev_route` tool, model switching |
| `config.ts` | config types, defaults, layered loading |
| `jev.ts` | TypeSafe HTTP client, question definitions, response parsing |
| `router.ts` | composition (`decide`), tier/kind chains, availability fallback |
| `budget.ts` | spend ledger, caps, pressure |

## Failure behaviour

Routing never blocks your turn. A missing key, network error, timeout (default
3.5 s, retried on 429/529), or unknown model means: warn in the status line and
run the prompt on the current model unchanged.

## Compatibility

Optional `ExtensionAPI` surfaces are feature-detected, so the extension loads on
older pi builds and downstream forks. If `registerEntryRenderer` or
`@earendil-works/pi-tui` is unavailable, the transcript card is skipped and
decisions still appear via the status bar and notifications. Missing
`appendEntry`, `ctx.ui.select`, or `modelRegistry.find` degrade to no persistence,
auto-switching, or "leave the model unchanged" respectively. `@earendil-works/pi-tui`
is an optional peer dependency.