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

export type Tier = "quick" | "standard" | "high" | "premium";
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium"] as const;

export type Mode = "auto" | "confirm" | "notify";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteTarget {
  provider: string;
  model: string;
  /** Optional thinking level pinned for this model. Clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Only used inside `kindModels`: this model may serve the kind when the
   * chosen tier is at or above `minTier`. Defaults to "quick".
   */
  minTier?: Tier;
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

export interface JevRouterConfig {
  enabled: boolean;
  mode: Mode;
  /**
   * When false, the built-in model chains (`routes`, `kindModels`) are dropped
   * entirely, so routing uses only the models your config provides. Other
   * defaults (endpoint, timeouts, budget, kind floors) still apply.
   */
  useDefaultModels: boolean;
  apiKeyEnv: string;
  apiKey?: string;
  endpointEnv: string;
  endpoint?: string;
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
  budget: BudgetConfig;
  cache: CacheConfig;
}

export const DEFAULT_CONFIG: JevRouterConfig = {
  enabled: true,
  mode: "auto",
  useDefaultModels: true,
  apiKeyEnv: "TYPESAFE_API_KEY",
  endpointEnv: "TYPESAFE_API_URL",
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

function normalizeChain(value: unknown): RouteChain | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const targets = list.filter(
    (item): item is RouteTarget =>
      Boolean(item) && typeof item === "object" && typeof (item as RouteTarget).provider === "string" && typeof (item as RouteTarget).model === "string",
  );
  return targets.length > 0 ? targets : undefined;
}

function merge(base: JevRouterConfig, patch: unknown): JevRouterConfig {
  const p = asRecord(patch);
  const routes = { ...base.routes };
  const rawRoutes = asRecord(p.routes);
  for (const tier of TIERS) {
    const chain = normalizeChain(rawRoutes[tier]);
    if (chain) routes[tier] = chain;
  }
  const kindModels = { ...base.kindModels };
  for (const [kind, value] of Object.entries(asRecord(p.kindModels))) {
    const chain = normalizeChain(value);
    if (chain) kindModels[kind] = chain;
  }
  return {
    ...base,
    ...(p as Partial<JevRouterConfig>),
    routes,
    kindModels,
    budget: { ...base.budget, ...asRecord(p.budget) } as BudgetConfig,
    cache: { ...base.cache, ...asRecord(p.cache) } as CacheConfig,
    kindMinimumTier: {
      ...base.kindMinimumTier,
      ...(asRecord(p.kindMinimumTier) as Record<string, Tier>),
    },
  };
}

export function configPaths(cwd?: string): { global: string; project?: string } {
  const global = join(homedir(), CONFIG_DIR_NAME, "agent", "pi-jev-model-router.json");
  return {
    global,
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

  if (globalPatch) config = merge(config, globalPatch);
  if (projectPatch) config = merge(config, projectPatch);

  if (process.env.JEV_ROUTER_MODE) {
    const mode = process.env.JEV_ROUTER_MODE.toLowerCase();
    if (mode === "auto" || mode === "confirm" || mode === "notify") config.mode = mode;
  }
  if (process.env.JEV_ROUTER_OFF === "1" || process.env.JEV_ROUTER_OFF === "true") {
    config.enabled = false;
  }
  return config;
}

function emptyChains(): Record<Tier, RouteChain> {
  return { quick: [], standard: [], high: [], premium: [] };
}

export function hasApiKey(config: JevRouterConfig): boolean {
  if (config.apiKey && config.apiKey.trim().length > 0) return true;
  const value = process.env[config.apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0;
}

export function apiKeyFor(config: JevRouterConfig): string {
  return config.apiKey?.trim() || process.env[config.apiKeyEnv]?.trim() || "";
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