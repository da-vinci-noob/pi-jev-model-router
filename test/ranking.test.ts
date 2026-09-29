import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type JevRouterConfig } from "../extensions/pi-jev-model-router/config";
import { loadScores, spreadByProvider, suggestRoutes, type Scores } from "../extensions/pi-jev-model-router/ranking";
import { decide, type AvailableModel } from "../extensions/pi-jev-model-router/router";

const dir = mkdtempSync(join(tmpdir(), "jev-ranking-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cost = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const m = (provider: string, id: string, c = cost(1, 1)): AvailableModel => ({ provider, id, cost: c });
const config = (overrides: Partial<JevRouterConfig["ranking"]> = {}): JevRouterConfig => ({
  ...DEFAULT_CONFIG,
  ranking: { ...DEFAULT_CONFIG.ranking, ...overrides },
});
const keys = (chain: { provider: string; model: string }[] | undefined) => (chain ?? []).map((t) => `${t.provider}/${t.model}`);

describe("suggestRoutes: tiers", () => {
  const models = [m("a", "q"), m("a", "s"), m("a", "h"), m("a", "p"), m("a", "top")];
  const scores: Scores = {
    models: {
      "a/q": { score: 0.49 },
      "a/s": { score: 0.5 },
      "a/h": { score: 0.7 },
      "a/p": { score: 0.85 },
      "a/top": { score: 1 },
    },
  };

  test("fixed cut-offs place each model on the highest tier it clears, inclusive", () => {
    const { routes } = suggestRoutes(config(), models, scores);
    expect(keys(routes.quick)).toEqual(["a/q"]);
    expect(keys(routes.standard)).toEqual(["a/s"]);
    expect(keys(routes.high)).toEqual(["a/h"]);
    expect(keys(routes.premium).sort()).toEqual(["a/p", "a/top"]);
  });

  test("xpremium is never filled, even by a perfect score", () => {
    expect(suggestRoutes(config(), models, scores).routes.xpremium).toBeUndefined();
  });

  test("custom cut-offs move models between tiers", () => {
    const { routes } = suggestRoutes(config({ cutoffs: { standard: 0.4, high: 0.5, premium: 0.95 } }), models, scores);
    expect(keys(routes.standard)).toEqual(["a/q"]);
    expect(keys(routes.high).sort()).toEqual(["a/h", "a/p", "a/s"]);
    expect(keys(routes.premium)).toEqual(["a/top"]);
  });

  test("tiers with no scored model are left out so they don't override anything", () => {
    const { routes } = suggestRoutes(config(), [m("a", "p")], { models: { "a/p": { score: 0.9 } } });
    expect(Object.keys(routes)).toEqual(["premium"]);
  });
});

describe("suggestRoutes: catalogue matching", () => {
  test("only models in pi's catalogue are used, matched on exact provider and id", () => {
    const scores: Scores = { models: { "a/x": { score: 0.9 }, "b/x": { score: 0.9 }, "a/gone": { score: 0.9 } } };
    const result = suggestRoutes(config(), [m("a", "x"), m("c", "x")], scores);
    expect(keys(result.routes.premium)).toEqual(["a/x"]);
    expect(result.unmatched.sort()).toEqual(["a/gone", "b/x"]);
  });
});

describe("suggestRoutes: ordering", () => {
  test("within a tier, higher score per cost comes first", () => {
    const models = [m("a", "pricey", cost(10, 30)), m("b", "cheap", cost(1, 3)), m("c", "mid", cost(3, 9))];
    const scores: Scores = { models: { "a/pricey": { score: 0.95 }, "b/cheap": { score: 0.86 }, "c/mid": { score: 0.9 } } };
    expect(keys(suggestRoutes(config(), models, scores).routes.premium)).toEqual(["b/cheap", "c/mid", "a/pricey"]);
  });

  test("a cost override replaces the catalogue price, and zero cost ranks first", () => {
    const models = [m("a", "sub", cost(10, 30)), m("b", "paid", cost(1, 3))];
    const scores: Scores = {
      models: { "a/sub": { score: 0.9, cost: { input: 0, output: 0 } }, "b/paid": { score: 0.9 } },
    };
    expect(keys(suggestRoutes(config(), models, scores).routes.premium)).toEqual(["a/sub", "b/paid"]);
  });

  test("models without catalogue pricing rank after priced ones at equal score", () => {
    const models: AvailableModel[] = [{ provider: "a", id: "unpriced" }, m("b", "priced")];
    const scores: Scores = { models: { "a/unpriced": { score: 0.9 }, "b/priced": { score: 0.9 } } };
    expect(keys(suggestRoutes(config(), models, scores).routes.premium)).toEqual(["b/priced", "a/unpriced"]);
  });

  test("free models are ordered by score, then key, regardless of file order", () => {
    const free = { input: 0, output: 0 };
    const models = [m("b", "low"), m("a", "high"), m("c", "tie")];
    const scores: Scores = {
      models: {
        "b/low": { score: 0.86, cost: free },
        "c/tie": { score: 0.9, cost: free },
        "a/high": { score: 0.9, cost: free },
      },
    };
    expect(keys(suggestRoutes(config({ spreadProviders: false }), models, scores).routes.premium)).toEqual([
      "a/high",
      "c/tie",
      "b/low",
    ]);
  });
});

describe("provider spread", () => {
  const t = (provider: string, model: string) => ({ provider, model });

  test("no two consecutive entries share a provider when it can be avoided, keeping order otherwise", () => {
    const chain = [t("a", "1"), t("a", "2"), t("b", "1"), t("a", "3"), t("c", "1")];
    expect(keys(spreadByProvider(chain))).toEqual(["a/1", "b/1", "a/2", "c/1", "a/3"]);
  });

  test("a chain from a single provider is returned unchanged", () => {
    const chain = [t("a", "1"), t("a", "2")];
    expect(spreadByProvider(chain)).toEqual(chain);
  });

  test("suggested chains are spread by default and kept in value order when turned off", () => {
    const models = [m("a", "1", cost(1, 1)), m("a", "2", cost(2, 2)), m("b", "1", cost(3, 3))];
    const scores: Scores = { models: { "a/1": { score: 0.9 }, "a/2": { score: 0.9 }, "b/1": { score: 0.9 } } };
    expect(keys(suggestRoutes(config(), models, scores).routes.premium)).toEqual(["a/1", "b/1", "a/2"]);
    expect(keys(suggestRoutes(config({ spreadProviders: false }), models, scores).routes.premium)).toEqual([
      "a/1",
      "a/2",
      "b/1",
    ]);
  });

  test("routing follows the spread order when the first specialist is unavailable", () => {
    const models = [m("a", "1", cost(1, 1)), m("a", "2", cost(2, 2)), m("b", "1", cost(3, 3))];
    const scores: Scores = {
      models: {
        "a/1": { score: 0.9, kinds: { implement: 0.9 } },
        "a/2": { score: 0.9, kinds: { implement: 0.9 } },
        "b/1": { score: 0.9, kinds: { implement: 0.9 } },
      },
    };
    const { kindModels } = suggestRoutes(config(), models, scores);
    expect(keys(kindModels.implement)).toEqual(["a/1", "b/1", "a/2"]);
    const routed = decide(
      {
        kind: "implement",
        kindConfidence: 0.9,
        kindProbabilities: {},
        complexity: 3,
        complexityConfidence: 0.9,
        budgetIntensity: 3,
        budgetIntensityConfidence: 0.9,
        deepReasoning: 0.5,
        latencyMs: 1,
      },
      { ...config(), kindModels },
      { models: models.slice(1), spend: { today: 0, month: 0, pressure: 0 } },
    );
    expect(`${routed?.model?.provider}/${routed?.model?.id}`).toBe("b/1");
  });
});

describe("suggestRoutes: kind specialists", () => {
  test("per-kind scores build kindModels, gated at the tier the kind score clears", () => {
    const models = [m("a", "coder"), m("b", "writer")];
    const scores: Scores = {
      models: {
        "a/coder": { score: 0.6, kinds: { implement: 0.9, write: 0.3 } },
        "b/writer": { score: 0.6, kinds: { write: 0.75 } },
      },
    };
    const { kindModels } = suggestRoutes(config(), models, scores);
    expect(kindModels.implement).toEqual([{ provider: "a", model: "coder", minTier: "premium", priority: 1 }]);
    expect(kindModels.write).toEqual([
      { provider: "b", model: "writer", minTier: "high", priority: 2 },
      { provider: "a", model: "coder", minTier: "quick", priority: 1 },
    ]);
  });

  test("routing picks the specialist the proposal ranks first, not the one with the highest gate", () => {
    const models = [m("a", "cheap", cost(1, 1)), m("b", "pricey", cost(20, 60))];
    const scores: Scores = {
      models: {
        "a/cheap": { score: 0.6, kinds: { implement: 0.6 } },
        "b/pricey": { score: 0.9, kinds: { implement: 0.9 } },
      },
    };
    const suggested = suggestRoutes(config(), models, scores);
    expect(keys(suggested.kindModels.implement)).toEqual(["a/cheap", "b/pricey"]);
    const routed = decide(
      {
        kind: "implement",
        kindConfidence: 0.9,
        kindProbabilities: {},
        complexity: 3,
        complexityConfidence: 0.9,
        budgetIntensity: 3,
        budgetIntensityConfidence: 0.9,
        deepReasoning: 0.5,
        latencyMs: 1,
      },
      { ...config(), kindModels: suggested.kindModels },
      { models, spend: { today: 0, month: 0, pressure: 0 } },
    );
    expect(routed?.model?.id).toBe("cheap");
  });

  test("kinds that are not in taskKinds are ignored", () => {
    const scores: Scores = { models: { "a/x": { score: 0.6, kinds: { juggling: 0.9 } } } };
    expect(suggestRoutes(config(), [m("a", "x")], scores).kindModels).toEqual({});
  });
});

describe("loadScores", () => {
  const file = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  test("missing and corrupt files return an error naming the path", () => {
    const missing = loadScores(join(dir, "nope.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("nope.json");
    const corrupt = loadScores(file("bad.json", "{not json"));
    expect(corrupt.ok).toBe(false);
  });

  test("entries with a non-finite score, bad kind scores, or a partial or negative cost are cleaned up", () => {
    const result = loadScores(
      file(
        "mixed.json",
        JSON.stringify({
          models: {
            "a/ok": { score: 0.8, kinds: { implement: 0.9, write: "high" }, cost: { input: 1, output: 2 } },
            "a/partial-cost": { score: 0.8, cost: { input: 1 } },
            "a/negative-cost": { score: 0.8, cost: { input: -1, output: 1 } },
            "a/no-score": { kinds: { implement: 0.9 } },
            "a/bad-score": { score: "0.9" },
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scores.models).toEqual({
      "a/ok": { score: 0.8, kinds: { implement: 0.9 }, cost: { input: 1, output: 2 } },
      "a/partial-cost": { score: 0.8 },
      "a/negative-cost": { score: 0.8 },
    });
  });
});
