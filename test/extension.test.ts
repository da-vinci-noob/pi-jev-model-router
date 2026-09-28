import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(realOs.tmpdir(), "jev-ext-home-"));
mock.module("node:os", () => ({ ...realOs, homedir: () => home }));
// Dynamic so the homedir mock is in place before config.ts computes its paths.
const { default: extension } = await import("../extensions/pi-jev-model-router/index");

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const models = ["quick-a", "std-a", "high-a", "prem-a"].map((id) => ({ provider: "testprov", id, cost }));
const realFetch = globalThis.fetch;
const savedKey = process.env.TYPESAFE_API_KEY;
let cwd: string;
let fetchCalls: string[];

function writeProjectConfig(patch: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-jev-model-router.json"),
    JSON.stringify({
      useDefaultModels: false,
      mode: "auto",
      stateFile: join(cwd, "state.json"),
      cache: { aware: false },
      routes: {
        quick: [{ provider: "testprov", model: "quick-a" }],
        standard: [{ provider: "testprov", model: "std-a", thinkingLevel: "low" }],
        high: [{ provider: "testprov", model: "high-a" }],
        premium: [{ provider: "testprov", model: "prem-a" }],
      },
      ...patch,
    }),
  );
}

function jevAnswers(kind = "implement", score = 1) {
  return {
    answers: {
      task_kind: { choice: kind, confidence: 0.9, probabilities: { [kind]: 0.9 } },
      complexity: { score, confidence: 0.9 },
      capability_deserved: { score, confidence: 0.9 },
      needs_deep_reasoning: { noul: 0.4 },
    },
  };
}

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return respond();
  }) as typeof fetch;
}

async function load(options: { minimal?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const setModel: unknown[] = [];
  const thinking: unknown[] = [];
  const fake: Record<string, unknown> = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
  if (!options.minimal) {
    Object.assign(fake, {
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      setModel: async (model: unknown) => (setModel.push(model), true),
      setThinkingLevel: (level: unknown) => thinking.push(level),
    });
  }
  // Partial fake: only the surface the extension touches, which is the point of the fork test.
  await extension(fake as unknown as ExtensionAPI);
  const notes: Array<[string, string]> = [];
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    },
    ui: { notify: (text: string, level: string) => notes.push([text, level]), setStatus: () => {} },
    sessionManager: { buildContextEntries: () => [] },
    getContextUsage: () => ({ tokens: 0 }),
  };
  await handlers.get("session_start")!({}, ctx);
  const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
  return { input, notes, setModel, thinking };
}

beforeEach(() => {
  cwd = mkdtempSync(join(realOs.tmpdir(), "jev-ext-cwd-"));
  fetchCalls = [];
  delete process.env.TYPESAFE_API_KEY;
  writeProjectConfig({ apiKey: "test-key" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  rmSync(cwd, { recursive: true, force: true });
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("pi extension", () => {
  test("routes a prompt end to end: switches to the judged tier model and pins its thinking level", async () => {
    stubFetch(() => Response.json(jevAnswers("implement", 1)));
    const { input, setModel, thinking } = await load();

    expect(await input("add a retry to the upload client")).toEqual({ action: "continue" });
    expect(fetchCalls).toHaveLength(1);
    expect(setModel).toEqual([models[1]]);
    expect(thinking).toEqual(["low"]);
  });

  test("keeps the current model when Jev picks the model already in use", async () => {
    stubFetch(() => Response.json(jevAnswers("chat", 0)));
    const { input, setModel } = await load();

    await input("what does this error mean in general terms");
    expect(fetchCalls).toHaveLength(1);
    expect(setModel).toEqual([]);
  });

  test("loads and still routes on a fork that only exposes pi.on", async () => {
    stubFetch(() => Response.json(jevAnswers("implement", 1)));
    const { input } = await load({ minimal: true });

    expect(await input("add a retry to the upload client")).toEqual({ action: "continue" });
    expect(fetchCalls).toHaveLength(1);
  });

  test("does not consult Jev for extension-originated input or slash commands", async () => {
    stubFetch(() => Response.json(jevAnswers()));
    const { input } = await load();

    await input("add a retry to the upload client", "extension");
    await input("/jev-router status");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a Jev HTTP failure warns and leaves the model unchanged", async () => {
    stubFetch(() => new Response("upstream down", { status: 500 }));
    const { input, notes, setModel } = await load();

    expect(await input("add a retry to the upload client")).toEqual({ action: "continue" });
    expect(setModel).toEqual([]);
    expect(notes).toContainEqual([expect.stringContaining("TypeSafe 500"), "warning"]);
  });

  test("without an API key it warns on session start and never calls Jev", async () => {
    writeProjectConfig({});
    stubFetch(() => Response.json(jevAnswers()));
    const { input, notes } = await load();

    expect(notes).toContainEqual([expect.stringContaining("no API key"), "warning"]);
    await input("add a retry to the upload client");
    expect(fetchCalls).toHaveLength(0);
  });
});
