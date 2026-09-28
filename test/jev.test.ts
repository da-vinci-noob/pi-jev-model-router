import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SpendSnapshot } from "../extensions/pi-jev-model-router/budget";
import { DEFAULT_CONFIG } from "../extensions/pi-jev-model-router/config";
import type { JevRouterConfig } from "../extensions/pi-jev-model-router/config";
import { JevError, classifyRequest } from "../extensions/pi-jev-model-router/jev";
import type { ClassifyInput } from "../extensions/pi-jev-model-router/jev";

const realFetch = globalThis.fetch;
const savedUrl = process.env.TYPESAFE_API_URL;

const config: JevRouterConfig = {
  ...DEFAULT_CONFIG,
  endpoint: "https://jev.test/v1/systemone",
  jevModel: "jev-test",
  timeoutMs: 10_000,
};
const spend: SpendSnapshot = { today: 1, month: 2, pressure: 0.5, dailyCap: 2 };
const input: ClassifyInput = { prompt: "fix the failing test", spend };

const answers = {
  task_kind: { choice: "debug", confidence: 0.8, probabilities: { debug: 0.8, implement: 0.2 } },
  complexity: { score: 2.4, confidence: 0.7 },
  capability_deserved: { score: 1.6, confidence: 0.6 },
  needs_deep_reasoning: { noul: 0.9 },
};

type Call = { url: string; init: RequestInit };
let calls: Call[];

function stubFetch(...responses: Array<() => Response>): void {
  let index = 0;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses[Math.min(index++, responses.length - 1)]();
  }) as unknown as typeof fetch;
}

const ok = (payload: unknown = { answers }) => () => Response.json(payload);
const status = (code: number, body = "") => () => new Response(body, { status: code });

beforeEach(() => {
  calls = [];
  delete process.env.TYPESAFE_API_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedUrl === undefined) delete process.env.TYPESAFE_API_URL;
  else process.env.TYPESAFE_API_URL = savedUrl;
});

describe("classifyRequest request", () => {
  test("posts state, jev model and questions to config.endpoint with bearer auth", async () => {
    stubFetch(ok());
    await classifyRequest(input, config, "sk-test");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(config.endpoint);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("jev-test");
    expect(Object.keys(body.questions).sort()).toEqual(
      ["capability_deserved", "complexity", "needs_deep_reasoning", "task_kind"],
    );
    expect(body.state.request).toBe(input.prompt);
    expect(body.state.budget).toEqual({
      spent_today_usd: 1,
      spent_this_month_usd: 2,
      daily_cap_usd: 2,
      monthly_cap_usd: null,
      fraction_of_budget_used: 0.5,
    });
  });

  test("conversation excerpt is capped to the last 4000 chars", async () => {
    stubFetch(ok());
    await classifyRequest({ ...input, history: `${"a".repeat(100)}${"b".repeat(4000)}` }, config, "k");
    expect(JSON.parse(String(calls[0].init.body)).state.conversation_excerpt).toBe("b".repeat(4000));
  });

  test("non-empty TYPESAFE_API_URL overrides config.endpoint", async () => {
    process.env.TYPESAFE_API_URL = "  https://override.test/jev  ";
    stubFetch(ok());
    await classifyRequest(input, config, "k");
    expect(calls[0].url).toBe("https://override.test/jev");
  });

  test("whitespace-only TYPESAFE_API_URL falls back to config.endpoint", async () => {
    process.env.TYPESAFE_API_URL = "   ";
    stubFetch(ok());
    await classifyRequest(input, config, "k");
    expect(calls[0].url).toBe(config.endpoint);
  });
});

describe("classifyRequest parsing", () => {
  test("maps answers and usage into a RouteAnalysis", async () => {
    stubFetch(ok({ answers, usage: { input_tokens: 120, output_tokens: 8 } }));
    const analysis = await classifyRequest(input, config, "k");
    expect(analysis).toMatchObject({
      kind: "debug",
      kindConfidence: 0.8,
      kindProbabilities: { debug: 0.8, implement: 0.2 },
      complexity: 2.4,
      complexityConfidence: 0.7,
      budgetIntensity: 1.6,
      budgetIntensityConfidence: 0.6,
      deepReasoning: 0.9,
      usage: { input_tokens: 120, output_tokens: 8 },
    });
  });

  test("deepReasoning falls back to noul_score", async () => {
    stubFetch(ok({ answers: { ...answers, needs_deep_reasoning: { noul_score: 0.3 } } }));
    expect((await classifyRequest(input, config, "k")).deepReasoning).toBe(0.3);
  });

  test("missing answers default to chat with neutral scores and no usage", async () => {
    stubFetch(ok({}));
    const analysis = await classifyRequest(input, config, "k");
    expect(analysis).toMatchObject({ kind: "chat", kindConfidence: 0, complexity: 1, budgetIntensity: 1, deepReasoning: 0 });
    expect(analysis.usage).toBeUndefined();
  });

  test("unknown task kind throws JevError", async () => {
    stubFetch(ok({ answers: { ...answers, task_kind: { choice: "juggle" } } }));
    const error = await classifyRequest(input, config, "k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).message).toContain("juggle");
  });

  test("configured task kinds are sent to Jev and accepted back", async () => {
    const withData = { ...config, taskKinds: { ...config.taskKinds, data: "Querying or transforming datasets" } };
    stubFetch(ok({ answers: { ...answers, task_kind: { choice: "data", confidence: 0.7 } } }));
    const analysis = await classifyRequest(input, withData, "k");
    expect(analysis.kind).toBe("data");
    const criteria = JSON.parse(String(calls[0].init.body)).questions.task_kind.criteria;
    expect(criteria).toEqual(withData.taskKinds);
  });
});

describe("classifyRequest retries and errors", () => {
  test("retries 429 and 529 then succeeds on the third attempt", async () => {
    stubFetch(status(429), status(529), ok());
    const analysis = await classifyRequest(input, config, "k");
    expect(calls).toHaveLength(3);
    expect(analysis.kind).toBe("debug");
  });

  test("gives up after three overloaded responses with the last status", async () => {
    stubFetch(status(429));
    const error = await classifyRequest(input, config, "k").catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).status).toBe(429);
  });

  test("other non-OK status throws immediately with status and body detail", async () => {
    stubFetch(status(401, "bad key"), ok());
    const error = await classifyRequest(input, config, "k").catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).status).toBe(401);
    expect((error as JevError).message).toContain("bad key");
  });

  test("already-aborted external signal throws without calling fetch", async () => {
    stubFetch(ok());
    const error = await classifyRequest(input, config, "k", AbortSignal.abort()).catch((e: unknown) => e);
    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).message).toBe("aborted");
  });
});
