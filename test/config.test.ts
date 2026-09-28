import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const osCopy = { ...realOs };
const fakeHome = mkdtempSync(join(realOs.tmpdir(), "jev-config-home-"));
mock.module("node:os", () => ({ ...osCopy, homedir: () => fakeHome }));
// Dynamic import: config must load after the node:os mock so the global file lives in fakeHome.

const { DEFAULT_CONFIG, TASK_KINDS, apiKeyFor, hasApiKey, loadConfig } = await import("../extensions/pi-jev-model-router/config");

const ENV_KEYS = ["TYPESAFE_API_KEY", "JEV_ROUTER_MODE", "JEV_ROUTER_OFF"] as const;
const globalFile = join(fakeHome, ".pi", "agent", "pi-jev-model-router.json");
let savedEnv: Record<string, string | undefined>;
let cwd: string;

function writeProject(patch: unknown): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-jev-model-router.json"), JSON.stringify(patch));
}

function writeGlobal(patch: unknown): void {
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(globalFile, JSON.stringify(patch));
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  cwd = mkdtempSync(join(realOs.tmpdir(), "jev-config-cwd-"));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(globalFile, { force: true });
});

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

const modelA = { provider: "testprov", model: "model-a" };
const modelB = { provider: "testprov", model: "model-b" };

describe("loadConfig", () => {
  test("returns defaults when no config files exist", () => {
    const config = loadConfig(cwd);
    expect(config.routes).toEqual(DEFAULT_CONFIG.routes);
    expect(config.kindModels).toEqual(DEFAULT_CONFIG.kindModels);
    expect(config.enabled).toBe(true);
  });

  test("per-tier routes override replaces only that tier", () => {
    writeProject({ routes: { high: [modelA] } });
    const config = loadConfig(cwd);
    expect(config.routes.high).toEqual([modelA]);
    expect(config.routes.quick).toEqual(DEFAULT_CONFIG.routes.quick);
    expect(config.routes.standard).toEqual(DEFAULT_CONFIG.routes.standard);
    expect(config.routes.premium).toEqual(DEFAULT_CONFIG.routes.premium);
  });

  test("xpremium is empty by default and only filled from config", () => {
    expect(loadConfig(cwd).routes.xpremium).toEqual([]);
    writeProject({ routes: { xpremium: [modelA] } });
    expect(loadConfig(cwd).routes.xpremium).toEqual([modelA]);
  });

  test("a single route object is accepted as a one-entry chain", () => {
    writeProject({ routes: { quick: modelA } });
    expect(loadConfig(cwd).routes.quick).toEqual([modelA]);
  });

  test("route entries without string provider and model are dropped, and an all-junk chain keeps the default", () => {
    writeProject({
      routes: {
        quick: [modelA, { provider: "testprov" }, { provider: 1, model: "x" }, null, "testprov/model-c"],
        standard: [{ model: "model-z" }],
      },
    });
    const config = loadConfig(cwd);
    expect(config.routes.quick).toEqual([modelA]);
    expect(config.routes.standard).toEqual(DEFAULT_CONFIG.routes.standard);
  });

  test("kind specialist priority keeps finite numbers and drops junk", () => {
    writeProject({
      kindModels: {
        write: [
          { ...modelA, priority: 2 },
          { ...modelB, priority: "high" },
          { provider: "testprov", model: "model-c", priority: null },
          { provider: "testprov", model: "model-d", priority: -1 },
        ],
      },
    });
    expect(loadConfig(cwd).kindModels.write.map((t) => t.priority)).toEqual([2, undefined, undefined, -1]);
  });

  test("kindModels override replaces only the named kind and can add new kinds", () => {
    writeProject({ kindModels: { plan: [modelA], custom: [modelB] } });
    const config = loadConfig(cwd);
    expect(config.kindModels.plan).toEqual([modelA]);
    expect(config.kindModels.custom).toEqual([modelB]);
    expect(config.kindModels.implement).toEqual(DEFAULT_CONFIG.kindModels.implement);
  });

  test("useDefaultModels false empties built-in chains but keeps non-model defaults", () => {
    writeProject({ useDefaultModels: false, routes: { standard: [modelA] } });
    const config = loadConfig(cwd);
    expect(config.routes).toEqual({ quick: [], standard: [modelA], high: [], premium: [], xpremium: [] });
    expect(config.kindModels).toEqual({});
    expect(config.endpoint).toBe(DEFAULT_CONFIG.endpoint);
    expect(config.kindMinimumTier).toEqual(DEFAULT_CONFIG.kindMinimumTier);
    expect(config.budget).toEqual(DEFAULT_CONFIG.budget);
  });

  test("project useDefaultModels wins over global, and project values win over global values", () => {
    writeGlobal({ useDefaultModels: false, mode: "notify", timeoutMs: 1000, routes: { high: [modelB] } });
    writeProject({ useDefaultModels: true, timeoutMs: 2000 });
    const config = loadConfig(cwd);
    expect(config.routes.quick).toEqual(DEFAULT_CONFIG.routes.quick);
    expect(config.routes.high).toEqual([modelB]);
    expect(config.mode).toBe("notify");
    expect(config.timeoutMs).toBe(2000);
  });

  test("global useDefaultModels false applies when the project does not set it", () => {
    writeGlobal({ useDefaultModels: false });
    writeProject({ routes: { quick: [modelA] } });
    const config = loadConfig(cwd);
    expect(config.routes).toEqual({ quick: [modelA], standard: [], high: [], premium: [], xpremium: [] });
    expect(config.kindModels).toEqual({});
  });

  test("budget and cache partial overrides keep the other defaults", () => {
    writeProject({ budget: { dailyUsd: 5 }, cache: { deadband: 0.5 } });
    const config = loadConfig(cwd);
    expect(config.budget).toEqual({ ...DEFAULT_CONFIG.budget, dailyUsd: 5 });
    expect(config.cache).toEqual({ ...DEFAULT_CONFIG.cache, deadband: 0.5 });
  });

  test("kindMinimumTier partial override keeps the other floors", () => {
    writeProject({ kindMinimumTier: { chat: "standard" } });
    expect(loadConfig(cwd).kindMinimumTier).toEqual({ ...DEFAULT_CONFIG.kindMinimumTier, chat: "standard" });
  });

  test("taskKinds default to the built-in kinds", () => {
    expect(loadConfig(cwd).taskKinds).toEqual(TASK_KINDS);
  });

  test("taskKinds add new kinds and override descriptions, project over global", () => {
    writeGlobal({ taskKinds: { data: "global data", infra: "Provisioning or changing infrastructure" } });
    writeProject({ taskKinds: { data: "Querying or transforming datasets", plan: "Custom planning text" } });
    expect(loadConfig(cwd).taskKinds).toEqual({
      ...TASK_KINDS,
      plan: "Custom planning text",
      data: "Querying or transforming datasets",
      infra: "Provisioning or changing infrastructure",
    });
  });

  test("taskKinds ignore entries without a non-empty string description", () => {
    writeProject({ taskKinds: { data: "", legal: 3, ops: null, plan: "   ", infra: "Provisioning infra" } });
    expect(loadConfig(cwd).taskKinds).toEqual({ ...TASK_KINDS, infra: "Provisioning infra" });
  });

  test("free pool merges valid fields", () => {
    writeProject({ free: { enabled: true, policy: "fallback-only", pool: [modelA] } });
    expect(loadConfig(cwd).free).toEqual({ enabled: true, policy: "fallback-only", pool: [modelA] });
  });

  test("free pool ignores junk pool, unknown policy and non-boolean enabled", () => {
    writeGlobal({ free: { enabled: true, policy: "fallback-only", pool: [modelB] } });
    writeProject({ free: { enabled: "yes", policy: "always", pool: [{ provider: "testprov" }] } });
    expect(loadConfig(cwd).free).toEqual({ enabled: true, policy: "fallback-only", pool: [modelB] });
  });

  test("corrupt project file is ignored", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-jev-model-router.json"), "{ not json");
    expect(loadConfig(cwd).routes).toEqual(DEFAULT_CONFIG.routes);
  });

  test("JEV_ROUTER_MODE overrides file mode case-insensitively and ignores unknown values", () => {
    writeProject({ mode: "notify" });
    process.env.JEV_ROUTER_MODE = "CONFIRM";
    expect(loadConfig(cwd).mode).toBe("confirm");
    process.env.JEV_ROUTER_MODE = "turbo";
    expect(loadConfig(cwd).mode).toBe("notify");
  });

  test("JEV_ROUTER_OFF disables only for 1 or true", () => {
    writeProject({ enabled: true });
    process.env.JEV_ROUTER_OFF = "1";
    expect(loadConfig(cwd).enabled).toBe(false);
    process.env.JEV_ROUTER_OFF = "true";
    expect(loadConfig(cwd).enabled).toBe(false);
    process.env.JEV_ROUTER_OFF = "0";
    expect(loadConfig(cwd).enabled).toBe(true);
  });

  test("env overrides do not leak into DEFAULT_CONFIG", () => {
    process.env.JEV_ROUTER_OFF = "1";
    process.env.JEV_ROUTER_MODE = "confirm";
    loadConfig(cwd);
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.mode).toBe("auto");
  });
});

describe("api key resolution", () => {
  const base = { ...DEFAULT_CONFIG, apiKeyEnv: "TYPESAFE_API_KEY" };

  test("config apiKey wins over env and is trimmed", () => {
    process.env.TYPESAFE_API_KEY = "env-key";
    const config = { ...base, apiKey: "  cfg-key  " };
    expect(hasApiKey(config)).toBe(true);
    expect(apiKeyFor(config)).toBe("cfg-key");
  });

  test("whitespace-only config apiKey falls back to env", () => {
    process.env.TYPESAFE_API_KEY = " env-key ";
    const config = { ...base, apiKey: "   " };
    expect(hasApiKey(config)).toBe(true);
    expect(apiKeyFor(config)).toBe("env-key");
  });

  test("whitespace-only or missing key everywhere counts as missing", () => {
    process.env.TYPESAFE_API_KEY = "   ";
    expect(hasApiKey({ ...base, apiKey: " " })).toBe(false);
    expect(apiKeyFor({ ...base, apiKey: " " })).toBe("");
    delete process.env.TYPESAFE_API_KEY;
    expect(hasApiKey(base)).toBe(false);
    expect(apiKeyFor(base)).toBe("");
  });
});
