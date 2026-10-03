# Working in pi-jev-model-router

## Project

A TypeScript/ESM pi extension, not a standalone server or app. TypeSafe Jev
judges task kind, complexity, capability, and reasoning; deterministic code owns
routing, dollar budgets, cache policy, and optional Codex quota gates.

Read the root `README.md` for behavior and configuration. Runtime source lives
under `extensions/pi-jev-model-router/`; `package.json` points pi at `index.ts`.
There is no build step: TypeScript checks use `noEmit`, and pi loads the source.
Runtime packages are host-provided peers; TUI support is optional and lazy-loaded.

## Repository map

| File | Responsibility | Tests |
| --- | --- | --- |
| `index.ts` | Pi events, commands/tool, runtime state, dialogs, switching, entries | `test/extension.test.ts` |
| `config.ts` | Types, defaults, validation, config layers, task kinds | `test/config.test.ts` |
| `jev.ts` | Four typed questions, HTTP retries/abort, response parsing | `test/jev.test.ts` |
| `router.ts` | Synchronous decisions, candidates, fallback, cache guards | `test/router.test.ts`, `test/quota-router.test.ts` |
| `budget.ts` | UTC spend ledger, caps, pressure, best-effort persistence | `test/budget.test.ts` |
| `ranking.ts` | Local scores, tier cutoffs, provider spread, route proposals | `test/ranking.test.ts` |
| `quota.ts` | Codex usage normalization, eligibility, background cache | `test/quota.test.ts`, `test/quota-router.test.ts` |

Source paths in this table are relative to `extensions/pi-jev-model-router/`.
The example JSON and extension README live there too. CI is
`.github/workflows/ci.yml`; npm ships `extensions/`, `assets/`, README, this guide,
and license.

## Workflow: TDD and PRs

1. Check `git status --short` and `git branch --show-current` before editing;
   preserve unrelated work. Work on a named feature/fix branch, not `main`.
2. For behavior changes, **write a focused failing test first**, run it to confirm
   the intended failure, implement the smallest fix, then refactor with tests
   green. Add regressions for bugs and boundary/failure cases for new policy.
   Documentation-only changes do not need artificial behavior tests.
3. Update the root README and relevant example/extension docs when behavior or
   configuration changes. Keep defaults backward-compatible unless explicitly
   requested otherwise.
4. Before every push, run the full local checks below and inspect the diff.
   Never push known failures; report what was tested and any limitations.
5. Recheck the current branch immediately before committing/pushing. Push only
   the feature branch and **open a PR targeting `main`**. Do not push directly to
   `main`, force-push shared branches, merge PRs, tag releases, or publish npm
   packages unless explicitly authorized. Use explicit PR base/head arguments.

```bash
bun install --frozen-lockfile
bun test test/router.test.ts --test-name-pattern 'relevant case' # focused red/green
bun run typecheck
bun test
git diff --check
```

CI uses Bun 1.4.0 and runs frozen install, typecheck, and tests. There is no
configured lint/format command; follow nearby TypeScript style (two spaces,
semicolons, double quotes). Do not add dependencies or churn the lockfile without
need. Do not disable commit signing to work around an error without approval.

## Design constraints

- Keep `decide()` synchronous and I/O-free. Fetching, UI, persistence, and model
  switching belong outside routing policy. Jev judgments are not budget policy.
- Demand stays on 0..3. `xpremium` is opt-in and gated; an unavailable normal
  chain must not accidentally enable it. A free pool is not a capability tier.
- Preserve candidate order: preferred free pool, eligible kind specialists,
  chosen tier, nearest neighboring tiers (lower first), fallback-only free pool.
  Specialist priority precedes `minTier` proximity. Explicit empty tier/kind
  lists clear chains; all-invalid lists keep the previous layer.
- Config layers: defaults → generated routes/kinds → global → project → env.
  Generated config cannot supply `xpremium` or unrelated settings. Never mutate
  `DEFAULT_CONFIG`, hand-edited user config, or real user state in tests.
- Resolve model availability through Pi. `findModel()` has a same-ID provider
  fallback; quota must use the **resolved provider**, not only the target label.
  Ordinary free-pool routing requires exact provider/model matching.
- Quota is remaining account ratio, separate from dollar pressure. Combine
  provider/target floors using the stricter value; equality passes. Missing,
  stale, or reset readings are unknown, not zero or a full allowance. Do not
  waive floors near reset or bypass eligibility via cache retention/overrides.
- Ordinary routing errors fail open. Opt-in quota protection can explicitly
  block submission to an ineligible current model; document that exception and
  never silently claim a blocked prompt ran or was queued.
- Feature-detect optional Pi APIs. Keep diagnostics observable through notes,
  notifications, and durable entries without sending decision entries to the LLM.
- Start background resources at session start, not extension construction, and
  clean them up at shutdown/reload. Never log credentials or quota HTTP bodies.

## Testing and integration

Tests use `bun:test`, mocked fetch, temporary directories, and fake Pi contexts;
they must not require live keys, external HTTP, or the user's `~/.pi` directory.
Config tests mock `node:os` **before dynamic imports** because some defaults are
computed at module load. Restore environment variables, fetch, clocks, files,
and background resources after each test. Global mocks mean concurrent test
execution needs special care; use the existing sequential workflow.

Test policy in the small modules and event/dialog interactions in extension
tests. Cover availability, all-rejected chains, unknown policies, stale/reset
readings, cancellation, and hosts missing optional APIs. For Pi API or TypeSafe
protocol changes, consult current upstream docs/types rather than inventing
methods or payloads. Live smoke runs can spend money and alter state: run them
only with permission, isolated configuration, and a clear report separating
mocked tests from live-provider verification.
