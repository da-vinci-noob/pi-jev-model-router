import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type CodexQuotaConfig, type JevRouterConfig, type RouteTarget } from "../extensions/pi-jev-model-router/config";
import type { RouteAnalysis } from "../extensions/pi-jev-model-router/jev";
import { decide, firstAvailable, type AvailableModel } from "../extensions/pi-jev-model-router/router";
import { quotaEligibility, type QuotaSnapshot } from "../extensions/pi-jev-model-router/quota";

const codex = "openai-codex";
const sol: RouteTarget = { provider: codex, model: "sol", minQuota: { weekly: 0.2 } };
const luna: RouteTarget = { provider: codex, model: "luna", minQuota: { fiveHour: 0.05 } };
const other: RouteTarget = { provider: "other", model: "alternative" };
const models = [sol, luna, other].map((t) => ({ provider: t.provider, id: t.model, cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } }));
const analysis: RouteAnalysis = { kind: "plan", kindConfidence: 0.9, kindProbabilities: {}, complexity: 3, complexityConfidence: 0.9, budgetIntensity: 3, budgetIntensityConfidence: 0.9, deepReasoning: 0.5, latencyMs: 0 };
const policy: CodexQuotaConfig = { enabled: true, cacheTtlSec: 120, onUnknown: "use", minQuota: { fiveHour: 0.05 } };
const snapshot: QuotaSnapshot = { fetchedAt: Date.now(), windows: { fiveHour: { remaining: 0.1 }, weekly: { remaining: 0.17 } } };
function eligible(reading: QuotaSnapshot | undefined = snapshot, config = policy) {
  return (target: RouteTarget, model: AvailableModel) => quotaEligibility(target, model.provider, config, reading);
}
function config(patch: Partial<JevRouterConfig> = {}): JevRouterConfig {
  return { ...DEFAULT_CONFIG, kindModels: {}, routes: { quick: [other], standard: [], high: [], premium: [sol, luna], xpremium: [] }, ...patch };
}
function route(patch: Partial<JevRouterConfig> = {}, reading = snapshot, extra = {}) {
  return decide(analysis, config(patch), { models, spend: { today: 0, month: 0, pressure: 0 }, eligibility: eligible(reading), ...extra });
}

test("target quota falls through a chain without changing dollar pressure", () => {
  const decision = route()!;
  expect(decision.model?.id).toBe("luna");
  expect(decision.budgetPressure).toBe(0);
  expect(decision.notes).toContain("sol skipped: codex weekly 17.0% < 20.0%");
});
test("provider floor rejects all shared-pool models and chooses another provider", () => {
  const decision = route({}, { ...snapshot, windows: { fiveHour: { remaining: 0.01 }, weekly: { remaining: 0.9 } } })!;
  expect(decision.model?.provider).toBe("other");
  expect(decision.notes.some((n) => n.startsWith("sol skipped"))).toBe(true);
  expect(decision.notes.some((n) => n.startsWith("luna skipped"))).toBe(true);
});
test("specialists, tier chains and preferred free pool all obey the same eligibility", () => {
  expect(route({ kindModels: { plan: [{ ...sol, minTier: "premium" }] } })?.model?.id).toBe("luna");
  expect(route({ free: { enabled: true, policy: "prefer", pool: [sol] } })?.model?.id).toBe("luna");
  expect(route({ free: { enabled: true, policy: "fallback-only", pool: [other] }, routes: { quick: [], standard: [], high: [], premium: [sol], xpremium: [] } })?.model?.id).toBe("alternative");
});
test("cache retention cannot keep a quota-rejected model even inside its demand band", () => {
  const decision = route({ cache: { aware: true, deadband: 0.25, maxPenaltyUsd: 0, bypassTierDelta: 2 } }, snapshot, { contextTokens: 100000, current: { index: 3, model: models[0] } })!;
  expect(decision.model?.id).toBe("luna");
  expect(decision.held).not.toBe(true);
});
test("all-rejected decisions preserve diagnostic notes", () => {
  const notes: string[] = [];
  const decision = route({ routes: { quick: [], standard: [], high: [], premium: [sol], xpremium: [] } }, snapshot, { notes });
  expect(decision).toBeUndefined();
  expect(notes).toEqual(["sol skipped: codex weekly 17.0% < 20.0%"]);
});
test("eligibility uses the resolved provider after model-ID fallback", () => {
  expect(firstAvailable(models, [{ ...sol, provider: "alias" }], eligible())).toBeUndefined();
  const available = firstAvailable([{ provider: "other", id: "sol" }], [sol], eligible(undefined, { ...policy, onUnknown: "skip" }));
  expect(available?.model.provider).toBe("other");
});
test("missing snapshots default to use with a note, while skip walks to another provider", () => {
  const unknown: QuotaSnapshot = { fetchedAt: Date.now(), windows: {} };
  expect(route({}, unknown)?.model?.id).toBe("sol");
  const decision = decide(analysis, config(), { models, spend: { today: 0, month: 0, pressure: 0 }, eligibility: eligible(unknown, { ...policy, onUnknown: "skip" }) });
  expect(decision?.model?.provider).toBe("other");
  expect(decision?.notes.some((n) => n.includes("quota unknown"))).toBe(true);
});
