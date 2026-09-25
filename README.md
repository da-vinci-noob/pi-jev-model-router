# pi-jev-model-router

A [pi](https://github.com/earendil-works/pi) extension that routes every prompt to
a task-appropriate model using **TypeSafe Jev** (System One) typed judgments.
You type normally; before the turn starts, Jev reads the request and answers four
narrow questions, code composes those into a capability tier, applies your budget
policy, and pi switches to the matching model.

![Routing decision shown in the transcript](assets/decision-entry.png)

<p align="center"><em>Every routed prompt shows the model it chose and the judgment behind it.</em></p>

- **Task-aware** — planning goes to reasoners, implementation to coding specialists, chat to cheap fast models.
- **Budget-aware** — daily/monthly caps downgrade tiers automatically instead of overspending.
- **Resilient** — each tier is a candidate chain; if a model is unavailable or unauthenticated, the next one is used.
- **Visible** — the transcript records the chosen model and the exact reason (kind, complexity, capability, reasoning, budget pressure).
- **Fails open** — a missing key, timeout, or unknown model just warns and runs your prompt on the current model.

## How it works

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
   pi.setModel(...) + pi.setThinkingLevel(...)  → the turn runs on that model
```

**Jev judges the task, code owns the budget.** Changing your spend caps never
invalidates the judgment, and the judgment stays a pure semantic read of the
request.

## Requirements

- pi (`@earendil-works/pi-coding-agent`)
- Node.js 20+
- A TypeSafe API key with access to `jev-latest` — <https://typesafe.ai>

## Install

### 1. Install pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify with `pi --version`. See the
[pi quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
for other installation methods and authentication options.

### 2. Install this package

From npm (recommended):

```bash
pi install npm:pi-jev-model-router
```

From a pinned git ref:

```bash
pi install git:github.com/da-vinci-noob/pi-jev-model-router@v0.3.0
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-jev-model-router
```

Try it once without installing:

```bash
pi -e npm:pi-jev-model-router
```

Manage it like any other pi package:

```bash
pi list                       # show installed packages
pi update --extensions        # update packages
pi remove npm:pi-jev-model-router
```

### 3. Set your TypeSafe API key

```bash
export TYPESAFE_API_KEY=...
```

Add it to your shell profile to persist it. You can also set `apiKey` directly in
the config file (see below).

### 4. Use it

Start pi and type a request. Before the turn runs, the router announces the
decision:

```
jev-router → high  openai/gpt-5.3-codex
implement · complexity 1.70/3 · capability 1.55/3 · reasoning 0.82 → high
```

The status bar shows `jev-router:<tier> · $spend · %cap`, or `jev-router:off` when
disabled. No configuration is required — sensible defaults are built in.

## Commands

| Command | What it does |
| --- | --- |
| `/jev-router` | Status: mode, spend, tier chains, kind specialists, last decision |
| `/jev-router on` / `off` | Enable/disable routing |
| `/jev-router mode auto\|confirm\|notify` | `auto` switches silently; `confirm` asks each turn; `notify` only tells you |
| `/jev-router budget daily 10` | Session-only daily cap (persist it in the config file) |
| `/jev-router budget monthly 150` | Session-only monthly cap |
| `/jev-router why` | Re-run Jev on the last prompt and show the full judgment + decision trace |
| `/jev-router revert` | Switch back to the model that was active before the last auto-switch |
| `/jev-route <text>` | Classify arbitrary text and show the recommendation without switching |

The model can also call the `jev_route` tool to ask for a tier recommendation for
a subtask.

### What you see

Every decision is a durable entry in the transcript, so the chosen model and its
justification are always available:

```
jev-router → high  openai/gpt-5.3-codex
implement · complexity 1.70/3 · capability 1.55/3 · reasoning 0.82 → high
· budget 12% of cap → one tier down
```

The glyph encodes the action: `→` switched, `=` already active (stickiness),
`•` notify-only mode, `×` skipped. Expand the entry for the raw judgment: kind
and confidence, complexity, capability deserved, deep-reasoning probability,
composed demand, and budget pressure. Entries are stored in the session but never
sent to the LLM, so they cost no context.

Prompts that are deliberately not routed are shown too, so behaviour is never
silently missing:

```
jev-router · not routed
acknowledgement — staying on the current model
using openrouter/~anthropic/claude-opus-latest
```

## Which models it uses by default

The defaults target **OpenRouter**, because it exposes a large catalogue through a
single provider id. Four capability tiers, each an ordered fallback chain:

| Tier | Order tried |
| --- | --- |
| `quick` | `~google/gemini-flash-latest` → `~openai/gpt-luna-latest` → `~z-ai/glm-flash-latest` → `~deepseek/deepseek-v4-flash-latest` |
| `standard` | `~deepseek/deepseek-pro-latest` → `openai/gpt-5.4-mini` → `~z-ai/glm-latest` |
| `high` | `~anthropic/claude-sonnet-latest` → `~openai/gpt-terra-latest` → `~google/gemini-pro-latest` → `~x-ai/grok-latest` |
| `premium` | `~anthropic/claude-opus-latest` → `openai/gpt-5.5` → `~openai/gpt-astra-latest` |

Plus kind specialists, tried before the tier chain when the chosen tier is high
enough (`minTier`):

| Kind | Specialists |
| --- | --- |
| `plan` | `~anthropic/claude-opus-latest` (≥premium) → `~openai/gpt-astra-latest` (≥premium) → `~openai/gpt-terra-latest` (≥high) → `~google/gemini-pro-latest` (≥standard) |
| `implement` | `openai/gpt-5.3-codex` (≥standard) → `moonshotai/kimi-k2.7-code` → `~anthropic/claude-sonnet-latest` |
| `debug` | `openai/gpt-5.3-codex` (≥standard) → `~openai/gpt-terra-latest` (≥high) → `~anthropic/claude-sonnet-latest` |
| `refactor` | `openai/gpt-5.3-codex` (≥standard) → `moonshotai/kimi-k2.7-code` |
| `review` | `~anthropic/claude-opus-latest` (≥high) → `openai/gpt-5.5` (≥high) → `~anthropic/claude-sonnet-latest` |
| `research` | `~google/gemini-pro-latest` (≥standard) → `moonshotai/kimi-k3` → `~openai/gpt-terra-latest` |
| `explain` | `~google/gemini-flash-latest` (≥quick) → `openai/gpt-5.4-mini` → `~google/gemini-pro-latest` (≥standard) |
| `operate` | `openai/gpt-5.4-mini` (≥standard) → `~deepseek/deepseek-pro-latest` |
| `chat` | `~google/gemini-flash-latest` → `~openai/gpt-luna-latest` → `~z-ai/glm-flash-latest` |
| `write` | `~google/gemini-flash-latest` (≥quick) → `openai/gpt-5.4-mini` → `~anthropic/claude-sonnet-latest` (≥standard) |

Provider-maintained `~...-latest` aliases are used wherever they exist, so the
chains follow new model releases instead of going stale.

Run `/jev-router` to see this for your own setup, with a `✓`/`✗` per route
showing what is actually available and authenticated.

## Extending to more models and providers

The router is provider-agnostic: it only references models that pi already knows
about, so **if pi can use a model, the router can route to it.** You are never
limited to OpenRouter — the defaults are just a convenient starting point.

### 0. Drop the built-in models entirely (optional)

By default your config is *merged over* the built-in chains, so a tier you don't
mention keeps its defaults. If you'd rather start from nothing and use only your
own models, set:

```json
{
  "useDefaultModels": false,
  "routes": {
    "quick": [{ "provider": "openrouter", "model": "~z-ai/glm-flash-latest" }],
    "high":  [{ "provider": "anthropic", "model": "claude-sonnet-4-5" }]
  },
  "kindModels": {
    "implement": [{ "provider": "openrouter", "model": "moonshotai/kimi-k2.7-code", "minTier": "standard" }]
  }
}
```

With `useDefaultModels: false`:

- the built-in `routes` and `kindModels` are **gone** — not available as a base
  or as fallback;
- tiers or kinds you don't configure are **empty**, and the router simply skips
  them (it never invents a model);
- everything that isn't a model list still applies — `endpoint`, timeouts,
  `budget`, `cache`, and the `kindMinimumTier` floors.

`/jev-router` prints `built-in models: off (config-only)` and marks empty tiers
as `(none configured)`. If a tier you need is empty, pi warns on session start.

### 1. Find the model ids pi knows

```bash
pi --list-models                 # all providers
pi --list-models | grep anthropic
pi --list-models | grep -E 'gpt-5|codex'
```

The first column is the **provider id** and the second is the **model id**. Those
are exactly the two fields the config uses.

> Providers not yet configured can be added with `pi /login`, an API key
> environment variable, or a custom provider registered by another extension —
> including local servers such as Ollama or llama.cpp. See the
> [providers docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

### 2. Point the tiers at your models

Create `~/.pi/agent/pi-jev-model-router.json` (or `<project>/.pi/pi-jev-model-router.json`).
Anything you set is merged over the defaults, per tier.

```json
{
  "routes": {
    "quick": [
      { "provider": "openrouter", "model": "~google/gemini-flash-latest" }
    ],
    "standard": [
      { "provider": "anthropic", "model": "claude-haiku-4-5" }
    ],
    "high": [
      { "provider": "anthropic", "model": "claude-sonnet-4-5" },
      { "provider": "openai", "model": "gpt-5.4" }
    ],
    "premium": [
      { "provider": "anthropic", "model": "claude-opus-4-5" },
      { "provider": "openai", "model": "gpt-5.5-pro" }
    ]
  }
}
```

Each tier is a **candidate chain**, tried top to bottom. The first model that
exists in pi's catalogue *and* is authenticated wins; if none are usable the
router steps to the nearest tier instead of failing. Add `"thinkingLevel"` to any
entry to pin it (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`;
pi clamps it per model).

Mixing providers is fine — put an OpenRouter model and a direct-Anthropic model in
the same chain.

### 3. Add or change task specialists

```json
{
  "kindModels": {
    "implement": [
      { "provider": "openrouter", "model": "openai/gpt-5.3-codex", "minTier": "standard" },
      { "provider": "anthropic", "model": "claude-sonnet-4-5", "minTier": "standard" }
    ],
    "plan": [
      { "provider": "openai", "model": "gpt-5.5", "minTier": "high" },
      { "provider": "anthropic", "model": "claude-opus-4-5", "minTier": "premium" }
    ]
  }
}
```

`minTier` gates a model to a minimum capability tier, so a specialist is only
used when the judgment justifies it. Among eligible specialists, the one whose
`minTier` is closest to the chosen tier wins — a cheap specialist never wins a
premium-quality turn.

### 4. Set the floor per task kind

```json
{
  "kindMinimumTier": {
    "plan": "high",
    "review": "high",
    "implement": "standard",
    "debug": "standard",
    "chat": "quick"
  }
}
```

Known kinds: `plan`, `implement`, `debug`, `refactor`, `review`, `research`,
`explain`, `operate`, `write`, `chat`.

### 5. Change which task kinds exist

The kinds are defined in `extensions/pi-jev-model-router/config.ts`
(`TASK_KINDS`) and passed to Jev as the choice criteria. Edit the labels, add
domains of your own (for example `data`, `infra`, `legal`), then add matching
entries under `kindModels` and `kindMinimumTier`. Because the question is a Jev
`choice`, the option set *is* the taxonomy — no retraining, no prompt parsing.

### Config resolution order

Later sources win:

1. built-in defaults
2. `~/.pi/agent/pi-jev-model-router.json`
3. `<cwd>/.pi/pi-jev-model-router.json` (trusted projects only)
4. env: `TYPESAFE_API_KEY`, `JEV_ROUTER_MODE` (`auto|confirm|notify`), `JEV_ROUTER_OFF=1`

A full example lives at
[`extensions/pi-jev-model-router/pi-jev-model-router.example.json`](extensions/pi-jev-model-router/pi-jev-model-router.example.json).
Run `/reload` after editing config.

## Budget management

Cost is accumulated from each assistant message's computed cost into
`~/.pi/agent/pi-jev-model-router-state.json`, together with Jev request counts.

```
pressure = max(today ÷ dailyUsd, month ÷ monthlyUsd)
```

- `pressure ≥ softRatio` (default `0.7`) → drop one tier
- `pressure ≥ hardRatio` (default `0.9`) → force `quick`, unless the demand score
  is ≥ 2.5 (clearly architectural), which may stay at `standard`

```json
{
  "budget": {
    "dailyUsd": 5,
    "monthlyUsd": 100,
    "softRatio": 0.7,
    "hardRatio": 0.9
  }
}
```

Omit either cap to disable that dimension. Caps are policy, not a hard stop —
they redirect routing, they do not block turns.

## Prompt-cache awareness

Switching models discards the provider's prompt cache, and caches are per-model.
The next request then re-reads the entire prefix — system prompt, tool schemas,
and conversation — at the new model's full input rate. Cache reads are ~10% of
input on the major providers, so a switch effectively costs the whole context
once, and a switch back costs it again. On a 50k context that is roughly
$0.10 on Sonnet; at 200k, roughly $0.45.

The router therefore gates switches instead of making them freely:

- **Cache penalty cap** — estimates the miss (`contextTokens × new model's input
  rate`, minus the cached rate) and refuses the switch when it exceeds
  `maxPenaltyUsd`.
- **Dead-band** — demand has to clear the current tier's band (`tier ± 0.5`) by
  `deadband` before a tier change is considered, so prompts hovering on a
  boundary stop flapping between two models.
- **Big-jump bypass** — a tier jump of `bypassTierDelta` or more still switches,
  because that is a genuine capability change rather than a marginal one.
- **Same-tier swaps count too** — a specialist swap such as Sonnet → Codex at the
  same tier is still a model change, and is priced the same way.

Held turns still record the decision, and say so:

```
jev-router = high  openrouter/~anthropic/claude-sonnet-latest
explain · complexity 0.40/3 · capability 0.30/3 · reasoning 0.20 → standard, held on high to keep the cache
· cache penalty ~$0.186 on 120k tokens — keeping the warm cache
```

The estimate is a lower bound — real cacheable prefixes include the system prompt
and tool schemas, which `contextTokens` does not count — and it is skipped
entirely when a model's pricing is unknown, so it never blocks on guesses. Set
`cache.aware: false` to restore unconditional switching.

```json
{
  "cache": {
    "aware": true,
    "deadband": 0.25,
    "maxPenaltyUsd": 0.05,
    "bypassTierDelta": 2
  }
}
```

## Configuration reference

| Key | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `useDefaultModels` | `true` | `false` drops the built-in model chains so only your config's models are used |
| `mode` | `"auto"` | `auto` \| `confirm` \| `notify` |
| `apiKeyEnv` / `apiKey` | `TYPESAFE_API_KEY` | TypeSafe credentials |
| `endpointEnv` / `endpoint` | `TYPESAFE_API_URL` | API endpoint | https://api.typesafe.ai/v1/systemone |
| `jevModel` | `"jev-latest"` | Jev model alias |
| `timeoutMs` | `3500` | Jev request timeout (retries 429/529) |
| `minPromptChars` | `12` | Below this, a prompt counts as a continuation (a short *first* message is still routed) |
| `historyTurns` | `4` | Conversation turns included as Jev state |
| `confidenceThreshold` | `0.34` | Below this, fall back to `standard` instead of spending premium |
| `stickiness` | `true` | Keep the current model when it is already the chosen one |
| `routes` | see above | Capability tier candidate chains |
| `kindModels` | see above | Task-specialist chains with `minTier` |
| `kindMinimumTier` | see above | Per-kind floor tier |
| `budget` | no caps | Spend policy |
| `cache` | `aware`, cap `$0.05`, deadband `0.25` | Prompt-cache-aware switching |
| `stateFile` | `~/.pi/agent/pi-jev-model-router-state.json` | Spend ledger |

## Failure behaviour

Routing never blocks your turn. A missing key, network error, timeout (default
3.5 s, retried on 429/529), or unknown model means: warn in the status line and
run the prompt on the current model unchanged. Prompts starting with `/`, pure
acknowledgements (`yes`, `continue`, …), and messages sent by other extensions
are never routed.

## Publishing to pi.dev/packages

The [pi package gallery](https://pi.dev/packages) is built from **npm**: it lists
packages that are tagged with the `pi-package` keyword. There is no separate
submission form — publishing to npm *is* the submission.

This repository is already prepared for it:

- `package.json` contains `"keywords": ["pi-package", ...]`
- `package.json` contains a `pi` manifest pointing at the extension entry point
- `package.json` contains `pi.image`, which the gallery uses as the preview card

To publish:

```bash
# 1. Log in to npm (once)
npm login

# 2. Sanity-check what will be shipped
npm pack --dry-run

# 3. Publish
npm publish --access public
```

Then:

1. The gallery indexes it on its next crawl (usually minutes; allow a few hours).
2. Check the listing at `https://pi.dev/packages/pi-jev-model-router`.
3. Anyone can then install it with `pi install npm:pi-jev-model-router`.

**Releases:** bump `version` in `package.json`, commit, tag, and re-run
`npm publish`. Keep the `image` URL pointed at a released tag or `main` so it
never 404s.

**If the name is taken**, publish under a scope (`@yourname/pi-jev-model-router`)
— the gallery indexes scoped packages too; install with
`pi install npm:@yourname/pi-jev-model-router`.

**Git-only distribution** also works (`pi install git:github.com/user/repo@v1`),
but only npm packages appear in the gallery.

You can also add a GIF or MP4 demo via `pi.video` (MP4 only, takes precedence
over `image`).

## Development

```bash
git clone https://github.com/da-vinci-noob/pi-jev-model-router
cd pi-jev-model-router

# load the package into a throwaway pi run (ignores auto-discovered extensions)
pi -ne -e "$PWD" -p "Explain what an idempotency key does."

# or copy into the auto-discovered location for hot reload
cp -R extensions/pi-jev-model-router ~/.pi/agent/extensions/
```

Layout:

| File | Role |
| --- | --- |
| `extensions/pi-jev-model-router/index.ts` | pi wiring: events, commands, `jev_route` tool, model switching, transcript entries |
| `extensions/pi-jev-model-router/config.ts` | config types, defaults, layered loading, task taxonomy |
| `extensions/pi-jev-model-router/jev.ts` | TypeSafe HTTP client, question definitions, response parsing |
| `extensions/pi-jev-model-router/router.ts` | composition (`decide`), tier/kind chains, availability fallback |
| `extensions/pi-jev-model-router/budget.ts` | spend ledger, caps, pressure |

No runtime dependencies: the extension talks to TypeSafe with plain `fetch`. It
imports `typebox` (tool schema) and `@earendil-works/pi-coding-agent` (config
directory path), and loads `@earendil-works/pi-tui` **lazily**, only when the host
implements `registerEntryRenderer`. `@earendil-works/pi-tui` is declared as an
**optional** peer dependency, so hosts that don't ship it still install and run.

## Compatibility with pi builds and forks

`ExtensionAPI` surfaces differ across pi versions and downstream forks (for
example `omp`). The extension probes the host at load time and degrades instead
of failing installation:

| Capability | If the host lacks it |
| --- | --- |
| `registerEntryRenderer` or `@earendil-works/pi-tui` | No transcript card; decisions still show in the status bar and notifications |
| `appendEntry` | Decisions are not persisted as session entries |
| `ctx.ui.notify` / `ctx.ui.setStatus` | Silently skipped |
| `ctx.ui.select` | `confirm` mode falls back to auto-switching |
| `ctx.modelRegistry.find` / `getAvailable` | Reports "model not available in this build" and leaves the current model in place |
| `registerCommand` / `registerTool` | Commands and the tool are not registered; event-driven routing still works |

Nothing in the extension throws during load if an optional API is missing, so
`pi install`, `omp install`, or any plugin validator will accept it.

## License

MIT