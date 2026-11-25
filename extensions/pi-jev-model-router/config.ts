import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * pi-jev-model-router config.
 *
 * Resolution order (later wins):
 *   1. DEFAULTS below
 *   2. ~/.pi/agent/pi-jev-model-router.json
 *   3. <cwd>/.pi/pi-jev-model-router.json   (only in a trusted project)
 *   4. env: TYPESAFE_API_KEY / JEV_ROUTER_MODE / JEV_ROUTER_OFF
 */

export type Tier = "quick" | "standard" | "high" | "premium" | "xpremium";
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"] as const;
/** Route to every tier unless a launcher caps the ceiling. */
export const DEFAULT_MAX_TIER: Tier = "xpremium";

export type Mode = "auto" | "confirm" | "notify";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteTarget {
  provider: string;
  model: string;
  /** Optional thinking level pinned for this model. Clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Only used inside `kindModels`: this model may serve the kind when the
   * chosen tier is at or above `minTier`. Defaults to "standard".
   */
  minTier?: Tier;
  /** Only used inside `kindModels`: higher wins among eligible specialists. Defaults to 0. */
  priority?: number;
  /** Minimum remaining account-quota ratios (0..1), currently Codex only. */
  minQuota?: QuotaFloors;
  /**
   * Optional deadline after which this target is skipped. ISO 8601 with timezone
   * or epoch milliseconds. Useful for time-limited promotional/free models.
   */
  expiresAt?: string | number;
}

export const QUOTA_WINDOWS = ["fiveHour", "weekly"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];
export type QuotaFloors = Partial<Record<QuotaWindow, number>>;

export interface CodexQuotaConfig {
  enabled: boolean;
  cacheTtlSec: number;
  onUnknown: "use" | "skip";
  /** Floors shared by every resolved openai-codex model. */
  minQuota: QuotaFloors;
}

/** Z.AI coding-plan quota. Only the 5h token window is reported and gated. */
export interface ZaiQuotaConfig {
  enabled: boolean;
  cacheTtlSec: number;
  onUnknown: "use" | "skip";
  /**
   * Floor for the shared 5h session window (unit 3). The lite plan reports no
   * weekly token window, so `weekly` is accepted but ignored by the reader.
   */
  minQuota: QuotaFloors;
}

/** Approval guard for switches into an expensive tier. */
export interface ConfirmConfig {
  /**
   * Tiers that ask before switching. Any other tier switches without asking.
   * Defaults to `["xpremium"]`, which is inert until `routes.xpremium` is
   * non-empty, so nothing changes for a config that never enables the tier.
   */
  tiers: Tier[];
  /** Dialog timeout in ms. `0` waits for an answer. */
  timeoutMs: number;
  /** What to do when the dialog times out or is dismissed without an answer. */
  onTimeout: "accept" | "reject";
}

/** A tier maps to an ordered candidate chain; the first available model wins. */
export type RouteChain = RouteTarget[];

export interface BudgetConfig {
  /** Rolling UTC-day spend cap in USD. Omit for no daily cap. */
  dailyUsd?: number;
  /** Calendar-month spend cap in USD. Omit for no monthly cap. */
  monthlyUsd?: number;
  /** Above this fraction of the cap, downgrade one tier. */
  softRatio: number;
  /** Above this fraction of the cap, force the cheapest tier. */
  hardRatio: number;
}

/**
 * Model switches invalidate the provider's prompt cache, so the next request
 * re-reads the whole prefix at full input price. These knobs keep the router
 * from paying that penalty for a marginal tier change.
 */
export interface CacheConfig {
  /** Master switch for cache/cost-aware hold decisions. */
  aware: boolean;
  /**
   * Demand must clear the current tier's band (tier ± 0.5) by this much before a
   * switch is considered. Damps flapping between adjacent tiers.
   */
  deadband: number;
  /**
   * Skip a switch whose estimated cache penalty exceeds this many USD, unless it
   * is a large upgrade. Set to 0 to allow any switch regardless of penalty.
   */
  maxPenaltyUsd: number;
  /** Tier jumps this large always switch, since they are quality-critical. */
  bypassTierDelta: number;
}

/**
 * Where a pool of zero-cost models sits relative to the tier chains.
 *
 * - `prefer`: try the pool first, then the kind and tier chains.
 * - `fallback-only`: try the pool last, after every tier chain.
 */
export type FreePolicy = "prefer" | "fallback-only";

/**
 * A pool of free models, consulted outside the tier scale.
 *
 * Tiers describe capability, not price, so there is nowhere in `TIERS` to put a
 * free model. Adding a `free` tier would collide with the demand math in
 * `decide()`, which rounds onto the existing four. A separate pool keeps the
 * judgment scale untouched, and it survives providers swapping their free
 * models, since the pool is plain config rather than a new tier.
 */
export interface FreePoolConfig {
  /** Master switch. When false the pool is ignored and routing is unchanged. */
  enabled: boolean;
  /** Whether the pool is tried before or after the tier chains. */
  policy: FreePolicy;
  /** Candidate chain, tried in order. The first available model wins. */
  pool: RouteChain;
}

export interface RankingConfig {
  scoresFile: string;
  /** Inclusive score floors per tier; below `standard` is quick. */
  cutoffs: { standard: number; high: number; premium: number };
  spreadProviders: boolean;
}

/** Reactive rate-limit parking, keyed by the resolved provider/model. */
export interface RateLimitConfig {
  enabled: boolean;
  parkMs: number;
}

/**
 * A named routing context: the constraints a launcher asks for when it selects one.
 *
 * One machine can run several pi launch paths with different tier access, e.g. a
 * chat opened by an app (`maxTier: "high"`) next to an interactive terminal that
 * keeps every tier. A rule applies only the fields it declares.
 */
export interface ContextRule {
  name: string;
  /** Environment variable names; a rule matches when any of them is set and non-empty. */
  matchEnv?: string[];
  maxTier?: Tier;
  enabled?: boolean;
  mode?: Mode;
}

export interface JevRouterConfig {
  enabled: boolean;
  mode: Mode;
  /**
   * When false, the built-in model chains (`routes`, `kindModels`) are dropped
   * entirely, so routing uses only the models your config provides. Other
   * defaults (endpoint, timeouts, budget, kind floors) still apply.
   */
  useDefaultModels: boolean;
  /**
   * Highest tier this process may route to. Everything above it is unreachable:
   * no candidate, no neighbouring-tier fallback, no specialist.
   *
   * This is the lever for a launching context (a bot chat, a subagent, a worker
   * agent) that cannot answer a routing dialog and must never spend premium
   * money. `enabled: false` would kill routing entirely; the ceiling keeps
   * routing and caps it. Defaults to `xpremium`, so nothing changes for a config
   * that does not set it.
   */
  maxTier?: Tier;
  /** Named routing contexts, tried in order. First match wins. */
  contexts?: ContextRule[];
  /** The context rule this process matched, if any. Output only. */
  context?: string;
  apiKeyEnv: string;
  apiKey?: string;
  endpointEnv: string;
  endpoint: string;
  jevModel: string;
  timeoutMs: number;
  minPromptChars: number;
  /** How many recent conversation turns to include as Jev state. */
  historyTurns: number;
  /** Below this choice confidence, fall back to the safe tier. */
  confidenceThreshold: number;
  /** Don't switch models when the current model already sits on the chosen tier. */
  stickiness: boolean;
  stateFile: string;
  routes: Record<Tier, RouteChain>;
  /**
   * Kind-specific model preferences. When a kind has a chain here, models are
   * tried before the generic tier chain (subject to `minTier`). This is how
   * "planning" and "implementation" can land on different specialists.
   */
  kindModels: Record<string, RouteChain>;
  /** Floor tier per task kind, so e.g. planning never lands on the quick model. */
  kindMinimumTier: Record<string, Tier>;
  /**
   * Zero-cost models tried outside the tier scale. Disabled by default, so an
   * existing config routes exactly as before.
   */
  free: FreePoolConfig;
  budget: BudgetConfig;
  cache: CacheConfig;
  taskKinds: Record<string, string>;
  ranking: RankingConfig;
  confirm: ConfirmConfig;
  quota: { "openai-codex"?: CodexQuotaConfig; zai?: ZaiQuotaConfig };
  recovery: { enabled: boolean; parkMs: number };
  rateLimit: RateLimitConfig;
  /**
   * Config values rejected at load time, reported once at session start.
   * Output only: a rejected value never loosens a limit, so a typo can not
   * silently raise the ceiling.
   */
  warnings?: string[];
}

export const TASK_KINDS: Record<string, string> = {
  plan: "Deciding what to build, sequencing work, or designing an approach before editing",
  implement: "Writing or changing code, scripts, or configuration to produce a concrete result",
  write: "Producing prose, documentation, comments, or other non-code content from scratch",
  debug: "Diagnosing a failure, error, or unexpected behavior and finding its root cause",
  refactor: "Restructuring existing code without changing intended behavior",
  review: "Auditing code, a diff, a document, or a plan for problems and risks",
  research: "Searching, reading, and synthesizing external information or unfamiliar APIs",
  explain: "Answering a question or explaining how something works",
  operate: "Running commands, tooling, git, deploys, or environment setup",
  chat: "Small talk, acknowledgements, or a request with no real work attached",
};

export const DEFAULT_CONFIG: JevRouterConfig = {
  enabled: true,
  mode: "auto",
  useDefaultModels: true,
  maxTier: "xpremium",
  apiKeyEnv: "TYPESAFE_API_KEY",
  endpointEnv: "TYPESAFE_API_URL",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  jevModel: "jev-latest",
  timeoutMs: 3500,
  minPromptChars: 12,
  historyTurns: 4,
  confidenceThreshold: 0.34,
  stickiness: true,
  stateFile: join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router-state.json"),
  routes: {
    quick: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", thinkingLevel: "off" },
      { provider: "openrouter", model: "~deepseek/deepseek-v4-flash-latest", thinkingLevel: "off" },
    ],
    standard: [
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", thinkingLevel: "low" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", thinkingLevel: "low" },
      { provider: "openrouter", model: "~z-ai/glm-latest", thinkingLevel: "low" },
    ],
    high: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", thinkingLevel: "medium" },
      { provider: "openrouter", model: "~x-ai/grok-latest", thinkingLevel: "medium" },
    ],
    premium: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", thinkingLevel: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", thinkingLevel: "high" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", thinkingLevel: "high" },
    ],
    xpremium: [],
  },
  kindModels: {
    // Planning and design: strong long-horizon reasoners.
    plan: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-astra-latest", minTier: "premium" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    // Implementation: coding specialists.
    implement: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    debug: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    refactor: [
      { provider: "openrouter", model: "openai/gpt-5.3-codex", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k2.7-code", minTier: "standard" },
    ],
    // Review and audit: strongest reviewers only.
    review: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest", minTier: "high" },
      { provider: "openrouter", model: "openai/gpt-5.5", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    // Research: long-context readers.
    research: [
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
      { provider: "openrouter", model: "moonshotai/kimi-k3", minTier: "standard" },
      { provider: "openrouter", model: "~openai/gpt-terra-latest", minTier: "standard" },
    ],
    explain: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~google/gemini-pro-latest", minTier: "standard" },
    ],
    operate: [
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "standard" },
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", minTier: "standard" },
    ],
    chat: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest", minTier: "quick" },
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", minTier: "quick" },
    ],
    write: [
      { provider: "openrouter", model: "~google/gemini-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "openai/gpt-5.4-mini", minTier: "quick" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
  },
  kindMinimumTier: {
    chat: "quick",
    explain: "quick",
    write: "quick",
    operate: "standard",
    implement: "standard",
    debug: "standard",
    refactor: "standard",
    research: "standard",
    plan: "high",
    review: "high",
  },
  budget: {
    dailyUsd: undefined,
    monthlyUsd: undefined,
    softRatio: 0.7,
    hardRatio: 0.9,
  },
  cache: {
    aware: true,
    deadband: 0.25,
    maxPenaltyUsd: 0.05,
    bypassTierDelta: 2,
  },
  free: {
    enabled: false,
    policy: "prefer",
    pool: [],
  },
  taskKinds: { ...TASK_KINDS },
  ranking: {
    // Getter: homedir() is resolved on read, not at import.
    get scoresFile() {
      return join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router.scores.json");
    },
    cutoffs: { standard: 0.5, high: 0.7, premium: 0.85 },
    spreadProviders: true,
  },
  quota: {},
  recovery: { enabled: false, parkMs: 3600000 },
  rateLimit: { enabled: true, parkMs: 86_400_000 },
  confirm: {
    tiers: ["xpremium"],
    timeoutMs: 10000,
    onTimeout: "accept",
  },
};

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeQuotaFloors(value: unknown): QuotaFloors {
  const floors: QuotaFloors = {};
  const raw = asRecord(value);
  for (const window of QUOTA_WINDOWS) {
    const floor = raw[window];
    if (typeof floor === "number" && Number.isFinite(floor) && floor >= 0 && floor <= 1) floors[window] = floor;
  }
  return floors;
}

/**
 * Keep a declared deadline as written. The value is validated where it is used,
 * because a deadline the router cannot read has to fail closed: dropping it would
 * leave the target unrestricted, which is the opposite of the intent.
 */
function normalizeExpiresAt(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A chain block may be written as one entry or as a list. */
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function normalizeChain(value: unknown): RouteChain | undefined {
  const list = asList(value);
  const targets = list.filter(
    (item): item is RouteTarget =>
      Boolean(item) && typeof item === "object" && typeof (item as RouteTarget).provider === "string" && typeof (item as RouteTarget).model === "string",
  );
  if (targets.length === 0) return undefined;
  return targets.map((t) => ({
    ...t,
    priority: t.priority === undefined || Number.isFinite(t.priority) ? t.priority : undefined,
    minQuota: t.minQuota === undefined ? undefined : normalizeQuotaFloors(t.minQuota),
    expiresAt: t.expiresAt === undefined ? undefined : normalizeExpiresAt(t.expiresAt),
  }));
}

/** A configured scores file: a bare path, or `~` for the home directory. */
function resolveScoresFile(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1));
  return value;
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is Mode {
  return value === "auto" || value === "confirm" || value === "notify";
}

function warn(config: JevRouterConfig, message: string): void {
  config.warnings = [...(config.warnings ?? []), message];
}

/**
 * Validate the declared contexts. An entry without a name is dropped silently; a
 * rule with an invalid field is dropped with a warning, since a broken rule must
 * never apply half of itself.
 */
function normalizeContexts(
  value: unknown,
  fallback: ContextRule[] | undefined,
  warnings: string[],
): ContextRule[] | undefined {
  if (!Array.isArray(value)) return fallback;
  const rules: ContextRule[] = [];
  for (const entry of value) {
    const parsed = parseContextRule(entry);
    if (!parsed) continue;
    if ("error" in parsed) warnings.push(parsed.error);
    else rules.push(parsed.rule);
  }
  return rules;
}

function parseContextRule(value: unknown): { rule: ContextRule } | { error: string } | undefined {
  const raw = asRecord(value);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return undefined;
  const rule: ContextRule = { name };
  if (raw.maxTier !== undefined) {
    if (!isTier(raw.maxTier)) {
      return { error: `context ${name}: maxTier ${JSON.stringify(raw.maxTier)} is not a tier; rule ignored.` };
    }
    rule.maxTier = raw.maxTier;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return { error: `context ${name}: enabled must be a boolean; rule ignored.` };
    rule.enabled = raw.enabled;
  }
  if (raw.mode !== undefined) {
    if (!isMode(raw.mode)) return { error: `context ${name}: mode ${JSON.stringify(raw.mode)} is not a mode; rule ignored.` };
    rule.mode = raw.mode;
  }
  if (raw.matchEnv !== undefined) {
    rule.matchEnv = Array.isArray(raw.matchEnv)
      ? raw.matchEnv
          .filter((marker): marker is string => typeof marker === "string" && marker.trim().length > 0)
          .map((marker) => marker.trim())
      : [];
  }
  return { rule };
}

/**
 * Validate a declared tier ceiling. An unknown value keeps the ceiling already in
 * effect (the default out of the box) and records a warning, so a typo can never
 * silently move the ceiling up.
 */
function normalizeMaxTier(value: unknown, fallback: Tier, warnings: string[]): Tier {
  if (value === undefined) return fallback;
  if (isTier(value)) return value;
  warnings.push(`maxTier ${JSON.stringify(value)} is not a tier; keeping ${fallback}.`);
  return fallback;
}

function merge(base: JevRouterConfig, patch: unknown): JevRouterConfig {
  const p = asRecord(patch);
  const warnings = [...(base.warnings ?? [])];
  const maxTier = normalizeMaxTier(p.maxTier, base.maxTier ?? DEFAULT_MAX_TIER, warnings);
  const contexts = normalizeContexts(p.contexts, base.contexts, warnings);
  const routes = { ...base.routes };
  const rawRoutes = asRecord(p.routes);
  for (const tier of TIERS) {
    const raw = rawRoutes[tier];
    const chain = Array.isArray(raw) && raw.length === 0 ? [] : normalizeChain(raw);
    if (chain) routes[tier] = chain;
  }
  const kindModels = { ...base.kindModels };
  for (const [kind, value] of Object.entries(asRecord(p.kindModels))) {
    const chain = Array.isArray(value) && value.length === 0 ? [] : normalizeChain(value);
    if (chain) kindModels[kind] = chain;
  }
  const taskKinds = { ...base.taskKinds };
  for (const [kind, value] of Object.entries(asRecord(p.taskKinds))) {
    if (typeof value === "string" && value.trim()) taskKinds[kind] = value;
  }
  const freePatch = asRecord(p.free);
  const freePool = normalizeChain(freePatch.pool);
  const free: FreePoolConfig = {
    enabled: typeof freePatch.enabled === "boolean" ? freePatch.enabled : base.free.enabled,
    policy:
      freePatch.policy === "prefer" || freePatch.policy === "fallback-only"
        ? freePatch.policy
        : base.free.policy,
    pool: freePool ?? base.free.pool,
  };
  const rankingPatch = asRecord(p.ranking);
  let cutoffs = { ...base.ranking.cutoffs };
  for (const [key, value] of Object.entries(asRecord(rankingPatch.cutoffs))) {
    if (key in cutoffs && typeof value === "number" && Number.isFinite(value)) cutoffs[key as keyof typeof cutoffs] = value;
  }
  if (!(cutoffs.standard <= cutoffs.high && cutoffs.high <= cutoffs.premium)) cutoffs = base.ranking.cutoffs;
  const scoresFile = resolveScoresFile(rankingPatch.scoresFile, base.ranking.scoresFile);
  const ranking: RankingConfig = {
    scoresFile,
    cutoffs,
    spreadProviders:
      typeof rankingPatch.spreadProviders === "boolean" ? rankingPatch.spreadProviders : base.ranking.spreadProviders,
  };
  const confirmPatch = asRecord(p.confirm);
  const confirmTiers = Array.isArray(confirmPatch.tiers)
    ? confirmPatch.tiers.filter((tier): tier is Tier => typeof tier === "string" && (TIERS as readonly string[]).includes(tier))
    : base.confirm.tiers;
  const confirm: ConfirmConfig = {
    tiers: confirmTiers,
    timeoutMs:
      typeof confirmPatch.timeoutMs === "number" &&
      Number.isFinite(confirmPatch.timeoutMs) &&
      confirmPatch.timeoutMs >= 0
        ? confirmPatch.timeoutMs
        : base.confirm.timeoutMs,
    onTimeout:
      confirmPatch.onTimeout === "accept" || confirmPatch.onTimeout === "reject"
        ? confirmPatch.onTimeout
        : base.confirm.onTimeout,
  };
  const recoveryPatch = asRecord(p.recovery);
  const recovery: JevRouterConfig["recovery"] = {
    enabled: typeof recoveryPatch.enabled === "boolean" ? recoveryPatch.enabled : base.recovery.enabled,
    parkMs:
      typeof recoveryPatch.parkMs === "number" && Number.isFinite(recoveryPatch.parkMs) && recoveryPatch.parkMs > 0
        ? recoveryPatch.parkMs
        : base.recovery.parkMs,
  };
  const rateLimitPatch = asRecord(p.rateLimit);
  const rateLimit: JevRouterConfig["rateLimit"] = {
    enabled: typeof rateLimitPatch.enabled === "boolean" ? rateLimitPatch.enabled : base.rateLimit.enabled,
    parkMs:
      typeof rateLimitPatch.parkMs === "number" && Number.isFinite(rateLimitPatch.parkMs) && rateLimitPatch.parkMs > 0
        ? rateLimitPatch.parkMs
        : base.rateLimit.parkMs,
  };

  const quota = { ...base.quota };
  const rawCodex = asRecord(p.quota)["openai-codex"];
  if (rawCodex && typeof rawCodex === "object" && !Array.isArray(rawCodex)) {
    const patch = asRecord(rawCodex);
    const previous = quota["openai-codex"];
    quota["openai-codex"] = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : previous?.enabled ?? true,
      cacheTtlSec: typeof patch.cacheTtlSec === "number" && Number.isFinite(patch.cacheTtlSec) && patch.cacheTtlSec >= 1 && patch.cacheTtlSec <= 86400
        ? patch.cacheTtlSec : previous?.cacheTtlSec ?? 120,
      onUnknown: patch.onUnknown === "use" || patch.onUnknown === "skip" ? patch.onUnknown : previous?.onUnknown ?? "use",
      minQuota: { ...previous?.minQuota, ...normalizeQuotaFloors(patch.minQuota) },
    };
  }
  const rawZai = asRecord(p.quota)["zai"];
  if (rawZai && typeof rawZai === "object" && !Array.isArray(rawZai)) {
    const patch = asRecord(rawZai);
    const previous = quota["zai"];
    quota["zai"] = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : previous?.enabled ?? true,
      cacheTtlSec: typeof patch.cacheTtlSec === "number" && Number.isFinite(patch.cacheTtlSec) && patch.cacheTtlSec >= 1 && patch.cacheTtlSec <= 86400
        ? patch.cacheTtlSec : previous?.cacheTtlSec ?? 120,
      onUnknown: patch.onUnknown === "use" || patch.onUnknown === "skip" ? patch.onUnknown : previous?.onUnknown ?? "use",
      minQuota: { ...previous?.minQuota, ...normalizeQuotaFloors(patch.minQuota) },
    };
  }
  return {
    ...base,
    ...(p as Partial<JevRouterConfig>),
    maxTier,
    contexts,
    warnings: warnings.length > 0 ? warnings : undefined,
    routes,
    kindModels,
    taskKinds,
    free,
    ranking,
    confirm,
    quota,
    recovery,
    rateLimit,
    budget: { ...base.budget, ...asRecord(p.budget) } as BudgetConfig,
    cache: { ...base.cache, ...asRecord(p.cache) } as CacheConfig,
    kindMinimumTier: {
      ...base.kindMinimumTier,
      ...(asRecord(p.kindMinimumTier) as Record<string, Tier>),
    },
  };
}

export function configPaths(cwd?: string): { global: string; generated: string; project?: string } {
  const agentDir = join(homedir(), CONFIG_DIR_NAME, "agent");
  return {
    global: join(agentDir, "pi-jev-model-router.json"),
    generated: join(agentDir, "pi-jev-model-router.generated.json"),
    project: cwd ? join(cwd, CONFIG_DIR_NAME, "pi-jev-model-router.json") : undefined,
  };
}

export function loadConfig(cwd?: string): JevRouterConfig {
  const paths = configPaths(cwd);
  const globalPatch = readJson(paths.global);
  const projectPatch = paths.project ? readJson(paths.project) : undefined;

  // `useDefaultModels: false` means "bring your own models": start from empty
  // chains so the built-ins are not available as a base or as fallback.
  // The last source that sets it wins.
  const explicit = [globalPatch, projectPatch]
    .map((patch) => asRecord(patch).useDefaultModels)
    .filter((value): value is boolean => typeof value === "boolean");
  const useDefaults = explicit.length > 0 ? explicit[explicit.length - 1] : DEFAULT_CONFIG.useDefaultModels;

  let config = useDefaults
    ? { ...DEFAULT_CONFIG }
    : { ...DEFAULT_CONFIG, routes: emptyChains(), kindModels: {} };

  const generated = asRecord(readJson(paths.generated));
  const { xpremium: _, ...generatedRoutes } = asRecord(generated.routes);
  config = merge(config, { routes: generatedRoutes, kindModels: generated.kindModels });
  if (globalPatch) config = merge(config, globalPatch);
  if (projectPatch) config = merge(config, projectPatch);

  // A named context narrows what this process may do, and only the fields it
  // declares. It runs before the env overrides, so an explicit env var still wins.
  applyContext(config);
  if (process.env.JEV_ROUTER_MODE) {
    const mode = process.env.JEV_ROUTER_MODE.toLowerCase();
    if (mode === "auto" || mode === "confirm" || mode === "notify") config.mode = mode;
  }
  if (process.env.JEV_ROUTER_OFF === "1" || process.env.JEV_ROUTER_OFF === "true") {
    config.enabled = false;
  }
  // A launcher caps its own process without touching a config file.
  applyEnvMaxTier(config);
  return config;
}

/**
 * Pick this process's routing context. `JEV_ROUTER_CONTEXT` selects a rule by name
 * and beats marker matching, so a launcher with no marker can still choose a
 * profile; otherwise the first rule with a set marker wins.
 */
function applyContext(config: JevRouterConfig): void {
  const rules = config.contexts ?? [];
  const selected = process.env.JEV_ROUTER_CONTEXT?.trim();
  const named = selected ? rules.find((rule) => rule.name === selected) : undefined;
  if (selected && !named) warn(config, `JEV_ROUTER_CONTEXT=${selected} matches no context; ignoring it.`);
  const rule =
    named ?? rules.find((candidate) => (candidate.matchEnv ?? []).some((marker) => Boolean(process.env[marker]?.trim())));
  if (!rule) return;
  if (rule.maxTier !== undefined) config.maxTier = rule.maxTier;
  if (rule.enabled !== undefined) config.enabled = rule.enabled;
  if (rule.mode !== undefined) config.mode = rule.mode;
  config.context = rule.name;
}

/** `JEV_ROUTER_MAX_TIER` narrows (or widens) the ceiling for this process only. */
function applyEnvMaxTier(config: JevRouterConfig): void {
  const raw = process.env.JEV_ROUTER_MAX_TIER?.trim().toLowerCase();
  if (!raw) return;
  if (isTier(raw)) {
    config.maxTier = raw;
    return;
  }
  warn(config, `JEV_ROUTER_MAX_TIER=${raw} is not a tier; keeping ${config.maxTier ?? DEFAULT_MAX_TIER}.`);
}

function emptyChains(): Record<Tier, RouteChain> {
  return { quick: [], standard: [], high: [], premium: [], xpremium: [] };
}

export function hasApiKey(config: JevRouterConfig): boolean {
  if (config.apiKey && config.apiKey.trim().length > 0) return true;
  const value = process.env[config.apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0;
}

export function apiKeyFor(config: JevRouterConfig): string {
  return config.apiKey?.trim() || process.env[config.apiKeyEnv]?.trim() || "";
}