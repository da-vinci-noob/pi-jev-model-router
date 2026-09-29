import { readFileSync } from "node:fs";
import type { JevRouterConfig, RouteChain, Tier } from "./config";
import type { AvailableModel } from "./router";

export interface ScoreEntry {
  score: number;
  kinds?: Record<string, number>;
  cost?: { input: number; output: number };
}

export interface Scores {
  models: Record<string, ScoreEntry>;
}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObj = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function loadScores(file: string): { ok: true; scores: Scores } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, error: `can't read scores file ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const models: Record<string, ScoreEntry> = {};
  for (const [key, value] of Object.entries(isObj(raw) && isObj(raw.models) ? raw.models : {})) {
    if (!isObj(value) || !isNum(value.score)) continue;
    const entry: ScoreEntry = { score: value.score };
    const kinds = Object.fromEntries(Object.entries(isObj(value.kinds) ? value.kinds : {}).filter(([, s]) => isNum(s)));
    if (Object.keys(kinds).length > 0) entry.kinds = kinds as Record<string, number>;
    if (isObj(value.cost) && isNum(value.cost.input) && isNum(value.cost.output) && value.cost.input >= 0 && value.cost.output >= 0) {
      entry.cost = { input: value.cost.input, output: value.cost.output };
    }
    models[key] = entry;
  }
  return { ok: true, scores: { models } };
}

export function spreadByProvider(chain: RouteChain): RouteChain {
  const rest = [...chain];
  const out: RouteChain = [];
  while (rest.length > 0) {
    const prev = out.at(-1)?.provider;
    const index = Math.max(0, rest.findIndex((t) => t.provider !== prev));
    out.push(...rest.splice(index, 1));
  }
  return out;
}

interface Candidate {
  key: string;
  provider: string;
  model: string;
  entry: ScoreEntry;
  price?: number;
}

function tierFor(score: number, cutoffs: JevRouterConfig["ranking"]["cutoffs"]): Tier {
  if (score >= cutoffs.premium) return "premium";
  if (score >= cutoffs.high) return "high";
  if (score >= cutoffs.standard) return "standard";
  return "quick";
}

function byValue(list: Candidate[], score: (c: Candidate) => number): Candidate[] {
  const value = (c: Candidate) => (c.price === undefined ? undefined : c.price <= 0 ? Infinity : score(c) / c.price);
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === undefined || vb === undefined) {
      if (va !== vb) return va === undefined ? 1 : -1;
    } else if (va !== vb) return vb - va;
    return score(b) - score(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

export function suggestRoutes(
  config: JevRouterConfig,
  models: readonly AvailableModel[],
  scores: Scores,
): { routes: Partial<Record<Tier, RouteChain>>; kindModels: Record<string, RouteChain>; unmatched: string[] } {
  const { cutoffs, spreadProviders } = config.ranking;
  const finish = (chain: RouteChain) => (spreadProviders ? spreadByProvider(chain) : chain);
  const candidates: Candidate[] = [];
  const unmatched: string[] = [];
  for (const [key, entry] of Object.entries(scores.models)) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    const available = slash > 0 ? models.find((m) => m.provider === provider && m.id === model) : undefined;
    if (!available) {
      unmatched.push(key);
      continue;
    }
    const cost = entry.cost ?? available.cost;
    candidates.push({ key, provider, model, entry, price: cost ? cost.input + cost.output : undefined });
  }

  const routes: Partial<Record<Tier, RouteChain>> = {};
  for (const tier of ["quick", "standard", "high", "premium"] as const) {
    const inTier = candidates.filter((c) => tierFor(c.entry.score, cutoffs) === tier);
    if (inTier.length > 0) {
      routes[tier] = finish(byValue(inTier, (c) => c.entry.score).map(({ provider, model }) => ({ provider, model })));
    }
  }

  const kindModels: Record<string, RouteChain> = {};
  for (const kind of Object.keys(config.taskKinds)) {
    const kindScore = (c: Candidate) => c.entry.kinds?.[kind] ?? 0;
    const withKind = candidates.filter((c) => c.entry.kinds?.[kind] !== undefined);
    if (withKind.length === 0) continue;
    kindModels[kind] = finish(
      byValue(withKind, kindScore).map((c) => ({ provider: c.provider, model: c.model, minTier: tierFor(kindScore(c), cutoffs) })),
    ).map((t, i, chain) => ({ ...t, priority: chain.length - i }));
  }
  return { routes, kindModels, unmatched };
}
