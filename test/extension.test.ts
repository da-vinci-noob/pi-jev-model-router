import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(realOs.tmpdir(), "jev-ext-home-"));
mock.module("node:os", () => ({ ...realOs, homedir: () => home }));
// Dynamic so the homedir mock is in place before config.ts computes its paths.
const { default: extension } = await import("../extensions/pi-jev-model-router/index");

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
const agentDir = join(home, ".pi", "agent");
const scoresFile = join(agentDir, "pi-jev-model-router.scores.json");
const generatedFile = join(agentDir, "pi-jev-model-router.generated.json");

const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const models = ["quick-a", "std-a", "high-a", "prem-a", "xprem-a"].map((id) => ({ provider: "testprov", id, cost }));
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

async function load(options: { minimal?: boolean; answer?: string | undefined; select?: string; current?: { provider: string; id: string } } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const setModel: unknown[] = [];
  const thinking: unknown[] = [];
  const dialogs: Array<{ title: string; placeholder?: string; opts?: unknown; options?: string[] }> = [];
  let answer = options.answer;
  const selectAnswer = options.select;
  const fake: Record<string, unknown> = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
  if (!options.minimal) {
    Object.assign(fake, {
      registerCommand: (name: string, command: Command) => commands.set(name, command),
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
    model: options.current ?? models[0],
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      notify: (text: string, level: string) => notes.push([text, level]),
      setStatus: () => {},
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        return selectAnswer;
      },
      input: async (title: string, placeholder?: string, opts?: unknown) => {
        dialogs.push({ title, placeholder, opts });
        return answer;
      },
    },
    sessionManager: { buildContextEntries: () => [] },
    getContextUsage: () => ({ tokens: 0 }),
  };
  await handlers.get("session_start")!({}, ctx);
  const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
  const command = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
  return { input, command, notes, setModel, thinking, dialogs, setAnswer: (v: string | undefined) => { answer = v } };
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

  test("session start does not warn about an unconfigured xpremium tier", async () => {
    stubFetch(() => Response.json(jevAnswers()));
    const { notes } = await load();

    expect(notes.filter(([text]) => text.includes("no models are configured"))).toEqual([]);
  });

  describe("confirm mode", () => {
    test("offers the cheaper rung only when there is one", async () => {
      writeProjectConfig({
        apiKey: "test-key",
        mode: "confirm",
        routes: {
          quick: [{ provider: "testprov", model: "quick-a" }],
          standard: [{ provider: "testprov", model: "std-a" }],
          high: [{ provider: "testprov", model: "high-a" }],
          premium: [{ provider: "testprov", model: "prem-a" }],
          xpremium: [],
        },
      });
      stubFetch(() => Response.json(jevAnswers("implement", 3)));
      const { input, dialogs, setModel } = await load({ select: "Use high — testprov/high-a" });

      // Premium demand lands on premium, whose cheaper rung is high.
      await input("plan a migration for the upload client");
      expect(dialogs[0].options).toEqual([
        "Use premium — testprov/prem-a",
        "Use high — testprov/high-a",
        "Keep testprov/quick-a",
      ]);
      expect(setModel).toEqual([models[2]]);
    });

    test("never lists the same tier twice on a quick turn", async () => {
      writeProjectConfig({ apiKey: "test-key", mode: "confirm" });
      // score 0 lands below standard, so the decision is quick itself. The
      // current model is moved off the quick pick so confirm actually opens.
      stubFetch(() => Response.json(jevAnswers("chat", 0)));
      const { input, dialogs, setModel } = await load({
        select: "Keep testprov/std-a",
        current: { provider: "testprov", id: "std-a" },
      });

      await input("what does this error mean in general terms");
      // Two entries, not three: the old clamp repeated "Use quick".
      expect(dialogs[0].options).toEqual(["Use quick — testprov/quick-a", "Keep testprov/std-a"]);
      expect(setModel).toEqual([]);
    });
  });

  describe("confirm.tiers gate", () => {
    const writeGuarded = (patch: Record<string, unknown> = {}) =>
      writeProjectConfig({
        apiKey: "test-key",
        routes: {
          quick: [{ provider: "testprov", model: "quick-a" }],
          standard: [{ provider: "testprov", model: "std-a" }],
          high: [{ provider: "testprov", model: "high-a" }],
          premium: [{ provider: "testprov", model: "prem-a" }],
          xpremium: [{ provider: "testprov", model: "xprem-a" }],
        },
        free: { enabled: true, policy: "fallback-only", pool: [{ provider: "testprov", model: "quick-a" }] },
        confirm: { tiers: ["premium", "xpremium"], timeoutMs: 10000, onTimeout: "accept" },
        ...patch,
      });

    beforeEach(() => writeGuarded());
    // score 3 on the 0..3 rubric makes demand round to premium, so xpremium is eligible.
    const expensive = () => stubFetch(() => Response.json(jevAnswers("implement", 3)));

    test("asks before an expensive tier and Enter accepts", async () => {
      expensive();
      const { input, setModel, dialogs } = await load({ answer: "" });

      await input("plan a migration for the upload client");
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0].title).toContain("xprem-a");
      expect(dialogs[0].placeholder).toContain("0 free");
      expect(dialogs[0].placeholder).toContain("1 quick");
      expect(dialogs[0].opts).toEqual({ timeout: 10000 });
      expect(setModel).toEqual([models[4]]);
    });

    test("N keeps the current model", async () => {
      expensive();
      const { input, setModel } = await load({ answer: "n" });

      await input("plan a migration for the upload client");
      expect(setModel).toEqual([]);
    });

    test("0 forces the free pool instead of the expensive model", async () => {
      expensive();
      const { input, setModel } = await load({ answer: "0" });

      await input("plan a migration for the upload client");
      expect(setModel).toEqual([models[0]]);
    });

    test("0 keeps the current model when the free pool is disabled", async () => {
      writeGuarded({ free: { enabled: false, policy: "fallback-only", pool: [] } });
      expensive();
      const { input, setModel } = await load({ answer: "0" });

      await input("plan a migration for the upload client");
      expect(setModel).toEqual([]);
    });

    test("a digit jumps straight to that tier", async () => {
      expensive();
      const { input, setModel, notes } = await load({ answer: "3" });

      await input("plan a migration for the upload client");
      expect(setModel).toEqual([models[2]]);
      expect(notes.some(([text]) => text.includes("user forced tier high"))).toBe(true);
    });

    test("an unrecognised answer keeps the current model", async () => {
      expensive();
      const { input, setModel } = await load({ answer: "maybe" });

      await input("plan a migration for the upload client");
      expect(setModel).toEqual([]);
    });

    test("no answer resolves through onTimeout", async () => {
      writeGuarded({ confirm: { tiers: ["xpremium"], timeoutMs: 10000, onTimeout: "accept" } });
      expensive();
      const accepted = await load({ answer: undefined });
      await accepted.input("plan a migration for the upload client");
      expect(accepted.setModel).toEqual([models[4]]);

      writeGuarded({ confirm: { tiers: ["xpremium"], timeoutMs: 10000, onTimeout: "reject" } });
      const rejected = await load({ answer: undefined });
      await rejected.input("plan a migration for the upload client");
      expect(rejected.setModel).toEqual([]);
    });

    test("timeoutMs 0 omits the dialog timeout", async () => {
      writeGuarded({ confirm: { tiers: ["xpremium"], timeoutMs: 0, onTimeout: "accept" } });
      expensive();
      const { input, dialogs } = await load({ answer: "y" });

      await input("plan a migration for the upload client");
      expect(dialogs[0].opts).toBeUndefined();
    });

    test("does not ask for a tier that is not guarded", async () => {
      writeGuarded({ confirm: { tiers: ["xpremium"], timeoutMs: 10000, onTimeout: "accept" } });
      stubFetch(() => Response.json(jevAnswers("implement", 1)));
      const { input, dialogs, setModel } = await load({ answer: "n" });

      await input("add a retry to the upload client");
      expect(dialogs).toEqual([]);
      expect(setModel).toEqual([models[1]]);
    });

    test("notify mode never opens the gate", async () => {
      writeGuarded({ mode: "notify" });
      expensive();
      const { input, dialogs, setModel } = await load({ answer: "" });

      await input("plan a migration for the upload client");
      expect(dialogs).toEqual([]);
      expect(setModel).toEqual([]);
    });

    test("the default config guards xpremium and nothing else", async () => {
      writeFileSync(
        join(cwd, ".pi", "pi-jev-model-router.json"),
        JSON.stringify({
          useDefaultModels: false,
          apiKey: "test-key",
          stateFile: join(cwd, "state.json"),
          cache: { aware: false },
          routes: { premium: [{ provider: "testprov", model: "prem-a" }] },
        }),
      );
      stubFetch(() => Response.json(jevAnswers("implement", 3)));
      const { input, dialogs } = await load({ answer: "y" });

      await input("plan a migration for the upload client");
      expect(dialogs).toEqual([]);
    });
  });

  describe("/jev-router suggest", () => {
    const writeScores = (models: Record<string, unknown>) => {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(scoresFile, JSON.stringify({ models }));
    };
    afterEach(() => {
      rmSync(scoresFile, { force: true });
      rmSync(generatedFile, { recursive: true, force: true });
    });

    test("prints a proposal from the scores file and pi's catalogue without writing anything", async () => {
      writeScores({ "testprov/prem-a": { score: 0.9 }, "testprov/std-a": { score: 0.6 }, "otherprov/x": { score: 0.9 } });
      const { command, notes } = await load();

      await command("jev-router", "suggest");
      const [text] = notes.at(-1)!;
      expect(text).toContain('"premium"');
      expect(text).toContain('"prem-a"');
      expect(text).toContain("otherprov/x");
      expect(existsSync(generatedFile)).toBe(false);
    });

    test("--write saves the generated file and applies it under hand-edited config", async () => {
      writeScores({
        "testprov/quick-a": { score: 0.6 },
        "testprov/high-a": { score: 0.75, kinds: { implement: 0.9 } },
      });
      const { command, notes } = await load();

      await command("jev-router", "suggest --write");
      const generated = JSON.parse(readFileSync(generatedFile, "utf8"));
      expect(generated.routes.standard).toEqual([{ provider: "testprov", model: "quick-a" }]);
      expect(generated.kindModels.implement).toEqual([{ provider: "testprov", model: "high-a", minTier: "premium", priority: 1 }]);

      await command("jev-router", "status");
      const [status] = notes.at(-1)!;
      expect(status).toContain("standard  testprov/std-a");
      expect(status).toContain("implement  standard–high: tier chain · premium: high-a");
    });

    test("--write refuses an empty proposal and keeps the existing generated file", async () => {
      mkdirSync(agentDir, { recursive: true });
      const previous = JSON.stringify({ routes: { high: [{ provider: "testprov", model: "high-a" }] } });
      writeFileSync(generatedFile, previous);
      writeScores({ "otherprov/not-in-catalogue": { score: 0.9 } });
      const { command, notes } = await load();

      await command("jev-router", "suggest --write");
      expect(notes.at(-1)).toEqual([expect.stringContaining("nothing to write"), "warning"]);
      expect(readFileSync(generatedFile, "utf8")).toBe(previous);
    });

    test("--write warns instead of throwing when the generated file can't be written", async () => {
      writeScores({ "testprov/prem-a": { score: 0.9 } });
      mkdirSync(join(generatedFile, "blocker"), { recursive: true });
      const { command, notes } = await load();

      await command("jev-router", "suggest --write");
      expect(notes.at(-1)).toEqual([expect.stringContaining(`can't write ${generatedFile}`), "warning"]);
      expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("a missing scores file warns with its path", async () => {
      const { command, notes } = await load();

      await command("jev-router", "suggest");
      expect(notes.at(-1)).toEqual([expect.stringContaining(scoresFile), "warning"]);
    });
  });
});
