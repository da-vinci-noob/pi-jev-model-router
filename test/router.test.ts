import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type JevRouterConfig, type RouteTarget } from "../extensions/pi-jev-model-router/config";
import type { RouteAnalysis } from "../extensions/pi-jev-model-router/jev";
import {
  type AvailableModel,
  type DecideOptions,
  decide,
  describeKindRoutes,
  estimateCachePenaltyUsd,
  findModel,
  firstAvailable,
  kindCandidates,
  tierForModel,
} from "../extensions/pi-jev-model-router/router";

const P = "testprov";

function model(id: string, cost?: AvailableModel["cost"], provider = P): AvailableModel {
  return { provider, id, cost };
}

const q1 = model("model-q1");
const q2 = model("model-q2");
const s1 = model("model-s1", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
const s2 = model("model-s2", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
const h1 = model("model-h1", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 });
const p1 = model("model-p1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 0 });
const ALL = [q1, q2, s1, s2, h1, p1];

function config(overrides: Partial<JevRouterConfig> = {}): JevRouterConfig {
  return {
    ...DEFAULT_CONFIG,
    routes: {
      quick: [
        { provider: P, model: "model-q1", thinkingLevel: "off" },
        { provider: P, model: "model-q2", thinkingLevel: "off" },
      ],
      standard: [
        { provider: P, model: "model-s1", thinkingLevel: "low" },
        { provider: P, model: "model-s2", thinkingLevel: "medium" },
      ],
      high: [{ provider: P, model: "model-h1", thinkingLevel: "medium" }],
      premium: [{ provider: P, model: "model-p1", thinkingLevel: "high" }],
    },
    kindModels: {},
    kindMinimumTier: {},
    free: { enabled: false, policy: "prefer", pool: [] },
    budget: { softRatio: 0.7, hardRatio: 0.9 },
    cache: { aware: false, deadband: 0.25, maxPenaltyUsd: 0.05, bypassTierDelta: 2 },
    ...overrides,
  };
}

function analysis(overrides: Partial<RouteAnalysis> = {}): RouteAnalysis {
  return {
    kind: "chat",
    kindConfidence: 0.9,
    kindProbabilities: {},
    complexity: 1,
    complexityConfidence: 0.9,
    budgetIntensity: 1,
    budgetIntensityConfidence: 0.9,
    deepReasoning: 0.5,
    latencyMs: 1,
    ...overrides,
  };
}

function options(overrides: Partial<DecideOptions> = {}): DecideOptions {
  return { models: ALL, spend: { today: 0, month: 0, pressure: 0 }, ...overrides };
}

function run(a: Partial<RouteAnalysis>, c: Partial<JevRouterConfig> = {}, o: Partial<DecideOptions> = {}) {
  const decision = decide(analysis(a), config(c), options(o));
  if (!decision) throw new Error("expected a decision");
  return decision;
}

const premiumDemand = { complexity: 3, budgetIntensity: 3 };
const highDemand = { complexity: 2, budgetIntensity: 2 };

describe("decide: demand → tier", () => {
  test("complexity outweighs capability (0.55 vs 0.45)", () => {
    const complexityHeavy = run({ complexity: 3, budgetIntensity: 0 });
    expect(complexityHeavy.demandScore).toBeCloseTo(1.65);
    expect(complexityHeavy.tier).toBe("high");

    const capabilityHeavy = run({ complexity: 0, budgetIntensity: 3 });
    expect(capabilityHeavy.demandScore).toBeCloseTo(1.35);
    expect(capabilityHeavy.tier).toBe("standard");
  });

  test("deep reasoning nudges up from 0.65 inclusive", () => {
    expect(run({ deepReasoning: 0.64 }).tier).toBe("standard");
    const nudged = run({ deepReasoning: 0.65 });
    expect(nudged.demandScore).toBeCloseTo(1.75);
    expect(nudged.tier).toBe("high");
  });

  test("shallow reasoning nudges down at 0.2 inclusive", () => {
    expect(run({ complexity: 0.7, budgetIntensity: 0.7, deepReasoning: 0.21 }).tier).toBe("standard");
    const nudged = run({ complexity: 0.7, budgetIntensity: 0.7, deepReasoning: 0.2 });
    expect(nudged.demandScore).toBeCloseTo(0.45);
    expect(nudged.tier).toBe("quick");
  });

  test("demand is clamped to 0..3", () => {
    const top = run({ ...premiumDemand, deepReasoning: 0.9 });
    expect(top.demandScore).toBe(3);
    expect(top.tier).toBe("premium");
    expect(run({ complexity: 0, budgetIntensity: 0, deepReasoning: 0 }).demandScore).toBe(0);
  });

  test("kindMinimumTier floors the tier and records a note", () => {
    const d = run({ kind: "plan", complexity: 0, budgetIntensity: 0 }, { kindMinimumTier: { plan: "high" } });
    expect(d.demandScore).toBe(2);
    expect(d.desiredTier).toBe("high");
    expect(d.tier).toBe("high");
    expect(d.notes).toContain("plan floors at high");
  });
});

describe("decide: confidence guard", () => {
  test("unsure classification above standard is capped at standard", () => {
    const d = run({ ...premiumDemand, kindConfidence: 0.2 });
    expect(d.desiredTier).toBe("premium");
    expect(d.tier).toBe("standard");
    expect(d.lowConfidenceFallback).toBe(true);
  });

  test("guard ignores zero confidence, confidence at threshold, and tiers at or below standard", () => {
    expect(run({ ...premiumDemand, kindConfidence: 0 }).tier).toBe("premium");
    expect(run({ ...premiumDemand, kindConfidence: 0.34 }).tier).toBe("premium");
    const standard = run({ kindConfidence: 0.2 });
    expect(standard.tier).toBe("standard");
    expect(standard.lowConfidenceFallback).toBe(false);
  });
});

describe("decide: budget guard", () => {
  const spend = (pressure: number) => ({ spend: { today: 1, month: 1, pressure } });

  test("soft ratio drops exactly one tier", () => {
    expect(run(highDemand, {}, spend(0.69)).tier).toBe("high");
    const d = run(highDemand, {}, spend(0.7));
    expect(d.tier).toBe("standard");
    expect(d.desiredTier).toBe("high");
    expect(d.downgraded).toBe(true);
  });

  test("hard ratio forces quick below demand 2.5", () => {
    const d = run({ complexity: 2.4, budgetIntensity: 2.4 }, {}, spend(0.9));
    expect(d.tier).toBe("quick");
    expect(d.downgraded).toBe(true);
  });

  test("hard ratio allows standard when demand is at least 2.5", () => {
    const d = run({ complexity: 2.5, budgetIntensity: 2.5 }, {}, spend(0.95));
    expect(d.desiredTier).toBe("premium");
    expect(d.tier).toBe("standard");
    expect(d.downgraded).toBe(true);
  });

  test("pressure on a quick decision is not a downgrade", () => {
    const low = { complexity: 0, budgetIntensity: 0 };
    expect(run(low, {}, spend(0.8)).downgraded).toBe(false);
    expect(run(low, {}, spend(0.95)).downgraded).toBe(false);
  });
});

describe("decide: kind specialists", () => {
  const spec = (id: string, minTier: NonNullable<RouteTarget["minTier"]>): RouteTarget => ({ provider: P, model: id, minTier });
  const kindModels = {
    implement: [spec("spec-quick", "quick"), spec("spec-high", "high"), spec("spec-std", "standard")],
  };
  const models = [...ALL, model("spec-quick"), model("spec-std"), model("spec-high")];

  test("closest eligible minTier wins over the tier chain", () => {
    const d = run({ kind: "implement" }, { kindModels }, { models });
    expect(d.tier).toBe("standard");
    expect(d.model?.id).toBe("spec-std");
    expect(d.kindSpecialised).toBe(true);
  });

  test("specialists above the chosen tier are excluded", () => {
    const quick = run({ kind: "implement", complexity: 0, budgetIntensity: 0 }, { kindModels }, { models });
    expect(quick.model?.id).toBe("spec-quick");
    expect(run({ kind: "implement", ...premiumDemand }, { kindModels }, { models }).model?.id).toBe("spec-high");
  });

  test("unavailable specialists fall through to the tier chain", () => {
    const d = run({ kind: "implement" }, { kindModels: { implement: [spec("spec-std", "standard")] } });
    expect(d.model?.id).toBe("model-s1");
    expect(d.kindSpecialised).toBe(false);
  });

  test("priority outranks a closer minTier without widening eligibility", () => {
    const ranked = {
      implement: [spec("spec-high", "high"), { ...spec("spec-quick", "quick"), priority: 1 }],
    };
    expect(run({ kind: "implement", ...highDemand }, { kindModels: ranked }, { models }).model?.id).toBe("spec-quick");
    expect(run({ kind: "implement", complexity: 0, budgetIntensity: 0 }, { kindModels: ranked }, { models }).model?.id).toBe(
      "spec-quick",
    );
    const gated = { implement: [{ ...spec("spec-high", "high"), priority: 5 }, spec("spec-std", "standard")] };
    expect(run({ kind: "implement" }, { kindModels: gated }, { models }).model?.id).toBe("spec-std");
  });

  test("equal priorities fall back to closest minTier", () => {
    const tied = { implement: kindModels.implement.map((t) => ({ ...t, priority: 3 })) };
    expect(run({ kind: "implement", ...highDemand }, { kindModels: tied }, { models }).model?.id).toBe("spec-high");
  });
});

describe("describeKindRoutes", () => {
  const spec = (id: string, minTier: NonNullable<RouteTarget["minTier"]>, priority?: number): RouteTarget => ({
    provider: P,
    model: id,
    minTier,
    priority,
  });
  const models = [...ALL, model("spec-std"), model("spec-high"), model("spec-free")];

  test("lists the winner per tier from the kind floor up, merging runs", () => {
    const c = config({
      kindModels: { implement: [spec("spec-std", "standard"), spec("spec-high", "high")] },
      kindMinimumTier: { implement: "quick" },
    });
    expect(describeKindRoutes(c, models, "implement")).toBe(
      "quick: tier chain · standard: spec-std · high–premium: spec-high",
    );
  });

  test("reflects priority and matches what decide() picks at each tier", () => {
    const c = config({
      kindModels: { write: [spec("spec-high", "high"), spec("spec-free", "quick", 1)] },
      kindMinimumTier: { write: "quick" },
    });
    expect(describeKindRoutes(c, models, "write")).toBe("quick–premium: spec-free");
    for (let i = 0; i < 4; i += 1) {
      const pick = firstAvailable(models, kindCandidates(c, "write", i));
      const d = decide(analysis({ kind: "write", complexity: i, budgetIntensity: i }), c, options({ models }));
      expect(d?.model?.id).toBe(pick?.model.id);
    }
  });
});

describe("decide: availability fallback", () => {
  test("unavailable chain climbs to the next tier with a note", () => {
    const d = run({ complexity: 0, budgetIntensity: 0 }, {}, { models: [s1, h1, p1] });
    expect(d.model?.id).toBe("model-s1");
    expect(d.tier).toBe("standard");
    expect(d.notes).toContain("quick chain unavailable → standard");
    expect(d.downgraded).toBe(false);
  });

  test("lower neighbour is tried before higher at equal distance", () => {
    expect(run(highDemand, {}, { models: [q1, s1, p1] }).model?.id).toBe("model-s1");
    expect(run({}, {}, { models: [q1, h1] }).model?.id).toBe("model-q1");
  });

  test("falling back to a lower tier reports that tier as a downgrade", () => {
    const d = run(highDemand, {}, { models: [q1, s1, p1] });
    expect(d.desiredTier).toBe("high");
    expect(d.tier).toBe("standard");
    expect(d.tierIndex).toBe(1);
    expect(d.downgraded).toBe(true);
    expect(d.notes).toContain("high chain unavailable → standard");
  });

  test("returns undefined when no configured model is available", () => {
    expect(decide(analysis(), config(), options({ models: [] }))).toBeUndefined();
    expect(decide(analysis(), config(), options({ models: [model("unlisted")] }))).toBeUndefined();
  });

  test("tier chain target resolves to a same-ID model on another provider", () => {
    const foreign = model("model-p1", undefined, "otherprov");
    const d = run(premiumDemand, {}, { models: [foreign] });
    expect(d.model).toBe(foreign);
    expect(d.target.provider).toBe(P);
    expect(d.tier).toBe("premium");
  });
});

describe("decide: free pool", () => {
  const freeModel = model("free-a", undefined, "freeprov");
  const pool: RouteTarget[] = [{ provider: "freeprov", model: "free-a" }];
  const models = [...ALL, freeModel];

  test("disabled pool is ignored even when its model is available", () => {
    const d = run({}, { free: { enabled: false, policy: "prefer", pool } }, { models });
    expect(d.model?.id).toBe("model-s1");
  });

  test("prefer wins at premium while the reported tier stays judged", () => {
    const d = run(premiumDemand, { free: { enabled: true, policy: "prefer", pool } }, { models });
    expect(d.model).toBe(freeModel);
    expect(d.tier).toBe("premium");
    expect(d.desiredTier).toBe("premium");
    expect(d.notes).toContain("free pool → free-a");
  });

  test("fallback-only is used only after every tier chain", () => {
    const free = { enabled: true, policy: "fallback-only" as const, pool };
    expect(run({}, { free }, { models: [p1, freeModel] }).model).toBe(p1);
    expect(run({}, { free }, { models: [freeModel] }).model).toBe(freeModel);
  });

  test("pool entries need an exact provider match", () => {
    const impostor = model("free-a", undefined, "otherprov");
    const free = { enabled: true, policy: "prefer" as const, pool };
    const d = run(premiumDemand, { free }, { models: [impostor, p1] });
    expect(d.model).toBe(p1);
    expect(decide(analysis(), config({ free: { ...free, policy: "fallback-only" } }), options({ models: [impostor] }))).toBeUndefined();
  });
});

describe("decide: cache guard", () => {
  const cache = { aware: true, deadband: 0.25, maxPenaltyUsd: 0.05, bypassTierDelta: 2 };

  test("holds a same-tier swap whose penalty exceeds the limit, keeping the entry's thinking level", () => {
    const d = run({}, { cache }, { contextTokens: 100_000, current: { index: 1, model: s2 } });
    expect(d.held).toBe(true);
    expect(d.model).toBe(s2);
    expect(d.tier).toBe("standard");
    expect(d.target).toEqual({ provider: P, model: "model-s2", thinkingLevel: "medium" });
    expect(d.kindSpecialised).toBe(false);
  });

  test("same-tier swap goes ahead when cheap or when cache awareness is off", () => {
    const cheap = run({}, { cache }, { contextTokens: 1_000, current: { index: 1, model: s2 } });
    expect(cheap.model).toBe(s1);
    expect(cheap.held).toBeUndefined();
    const unaware = run({}, { cache: { ...cache, aware: false } }, { contextTokens: 100_000, current: { index: 1, model: s2 } });
    expect(unaware.model).toBe(s1);
  });

  test("holds while demand sits inside the current band plus deadband", () => {
    const current = { index: 2, model: h1 };
    const inside = run({ complexity: 1.3, budgetIntensity: 1.3 }, { cache }, { current });
    expect(inside.held).toBe(true);
    expect(inside.model).toBe(h1);
    expect(inside.tier).toBe("high");
    expect(inside.desiredTier).toBe("standard");
    expect(inside.target.thinkingLevel).toBe("medium");

    const outside = run({ complexity: 1.2, budgetIntensity: 1.2 }, { cache }, { current });
    expect(outside.held).toBeUndefined();
    expect(outside.model).toBe(s1);
  });

  test("small upgrade holds on a high penalty but a big upgrade switches anyway", () => {
    const ctx = { contextTokens: 1_000_000 };
    const small = run(highDemand, { cache }, { ...ctx, current: { index: 1, model: s1 } });
    expect(small.held).toBe(true);
    expect(small.model).toBe(s1);

    const big = run(premiumDemand, { cache }, { ...ctx, current: { index: 0, model: q1 } });
    expect(big.held).toBeUndefined();
    expect(big.model).toBe(p1);
  });
});

describe("findModel / firstAvailable", () => {
  const foreign = model("model-s1", undefined, "otherprov");

  test("exact provider match beats a same-ID model listed earlier", () => {
    expect(findModel([foreign, s1], { provider: P, model: "model-s1" })).toBe(s1);
  });

  test("falls back to a same-ID model on another provider", () => {
    expect(findModel([foreign], { provider: P, model: "model-s1" })).toBe(foreign);
    expect(findModel([foreign], { provider: P, model: "model-x" })).toBeUndefined();
  });

  test("firstAvailable honours chain order and returns the matching target", () => {
    const chain: RouteTarget[] = [
      { provider: P, model: "missing" },
      { provider: P, model: "model-h1", thinkingLevel: "high" },
      { provider: P, model: "model-q1" },
    ];
    const hit = firstAvailable(ALL, chain);
    expect(hit?.model).toBe(h1);
    expect(hit?.target).toBe(chain[1]);
    expect(firstAvailable(ALL, [{ provider: P, model: "missing" }])).toBeUndefined();
  });
});

describe("tierForModel", () => {
  test("resolves route tiers, then kind minTier, else undefined", () => {
    const c = config({
      kindModels: {
        implement: [
          { provider: P, model: "spec-std", minTier: "standard" },
          { provider: P, model: "model-q1", minTier: "premium" },
        ],
      },
    });
    expect(tierForModel(`${P}/model-h1`, c)).toBe(2);
    expect(tierForModel(`${P}/spec-std`, c)).toBe(1);
    expect(tierForModel(`${P}/model-q1`, c)).toBe(0);
    expect(tierForModel("otherprov/model-h1", c)).toBeUndefined();
    expect(tierForModel(undefined, c)).toBeUndefined();
  });

  test("a kind specialist without minTier is gated at standard", () => {
    const c = config({ kindModels: { chat: [{ provider: P, model: "spec-nogate" }] } });
    const models = [...ALL, model("spec-nogate")];
    expect(tierForModel(`${P}/spec-nogate`, c)).toBe(1);
    expect(decide(analysis({ complexity: 0, budgetIntensity: 0 }), c, options({ models }))?.model?.id).toBe("model-q1");
    expect(decide(analysis({ complexity: 1, budgetIntensity: 1 }), c, options({ models }))?.model?.id).toBe("spec-nogate");
  });
});

describe("estimateCachePenaltyUsd", () => {
  test("prices the cold re-read minus the warm cached read", () => {
    const target = model("t", { input: 3, output: 0, cacheRead: 0, cacheWrite: 3.75 });
    const current = model("c", { input: 0, output: 0, cacheRead: 0.3, cacheWrite: 0 });
    expect(estimateCachePenaltyUsd(100_000, current, target)).toBeCloseTo(0.645);
    expect(estimateCachePenaltyUsd(100_000, model("c"), target)).toBeCloseTo(0.675);
  });

  test("is zero for unknown pricing, empty or invalid context, and never negative", () => {
    expect(estimateCachePenaltyUsd(100_000, s1, model("t"))).toBe(0);
    for (const tokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateCachePenaltyUsd(tokens, s1, p1)).toBe(0);
    }
    expect(estimateCachePenaltyUsd(100_000, p1, model("t", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBe(0);
  });
});
