import { describe, expect, test } from "bun:test";
import type { CodexQuotaConfig, RouteTarget } from "../extensions/pi-jev-model-router/config";
import { CODEX_USAGE_URL, CodexQuotaCache, codexAccountId, parseCodexUsage, quotaEligibility } from "../extensions/pi-jev-model-router/quota";

const now = 1_800_000_000_000;
const config: CodexQuotaConfig = { enabled: true, cacheTtlSec: 120, onUnknown: "use", minQuota: { fiveHour: 0.05 } };
const target: RouteTarget = { provider: "openai-codex", model: "expensive", minQuota: { weekly: 0.2 } };
function payload(used = 83) {
  return { rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: now / 1000 + 600 },
    secondary_window: { used_percent: 90, limit_window_seconds: 18000, reset_at: now / 1000 + 300 },
  } };
}
function check(snapshot = parseCodexUsage(payload(), now), patch: Partial<CodexQuotaConfig> = {}, t = target, time = now) {
  return quotaEligibility(t, t.provider, { ...config, ...patch }, snapshot, time);
}

describe("Codex quota normalization and eligibility", () => {
  test("normalizes percentages and identifies windows by duration, not position", () => {
    const snapshot = parseCodexUsage(payload(), now);
    expect(snapshot.windows.weekly?.remaining).toBeCloseTo(0.17);
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.1);
    expect(snapshot.windows.weekly?.resetAt).toBe(now + 600000);
    expect(check().allowed).toBe(false);
    expect(check().notes[0]).toContain("weekly 17.0% < 20.0%");
  });
  test("unknown durations and malformed readings are not invented", () => {
    expect(parseCodexUsage(null, now).windows).toEqual({});
    for (const used of [-1, 101, Infinity, "20", null]) {
      expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } } }, now).windows).toEqual({});
    }
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600 } } }, now).windows).toEqual({});
  });
  test("inclusive floors and stricter provider/target combination", () => {
    const snapshot = { fetchedAt: now, windows: { fiveHour: { remaining: 0.05 }, weekly: { remaining: 0.2 } } };
    expect(check(snapshot).allowed).toBe(true);
    expect(check(snapshot, { minQuota: { weekly: 0.3 } }).allowed).toBe(false);
    expect(check(snapshot, {}, { ...target, minQuota: { fiveHour: 0.01 } }).allowed).toBe(true);
    expect(check(snapshot, {}, { ...target, minQuota: { fiveHour: 0.1 } }).allowed).toBe(false);
  });
  test("missing, stale, future-dated and reset readings obey unknown policy", () => {
    const good = parseCodexUsage(payload(50), now);
    for (const snapshot of [undefined, { fetchedAt: now, windows: {} }, { ...good, fetchedAt: now - 120000 }, { ...good, fetchedAt: now + 1 }, { ...good, windows: { weekly: { remaining: 0.9, resetAt: now } } }]) {
      for (const onUnknown of ["use", "skip"] as const) {
        const result = quotaEligibility(target, target.provider, { ...config, onUnknown }, snapshot, now);
        expect(result.allowed).toBe(onUnknown === "use");
        expect(result.notes.some((note) => note.includes("quota unknown"))).toBe(true);
      }
    }
  });
  test("a nearby reset never waives a known floor", () => {
    expect(check({ fetchedAt: now, windows: { fiveHour: { remaining: 0.01, resetAt: now + 1000 }, weekly: { remaining: 0.5 } } }).allowed).toBe(false);
  });
  test("other providers, disabled guards and unguarded targets remain unchanged", () => {
    expect(quotaEligibility(target, "other", config, undefined, now)).toEqual({ allowed: true, notes: [] });
    expect(check(undefined, { enabled: false })).toEqual({ allowed: true, notes: [] });
    expect(quotaEligibility({ provider: target.provider, model: "plain" }, target.provider, { ...config, minQuota: {} }, undefined, now)).toEqual({ allowed: true, notes: [] });
  });
});

describe("Codex background cache", () => {
  test("uses fixed endpoint, fresh Pi token and account header; never fetches on construction", async () => {
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;
    let calls = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe(CODEX_USAGE_URL);
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ Authorization: `Bearer ${token}`, Accept: "application/json", "ChatGPT-Account-Id": "account-1" });
      return Response.json(payload());
    }) as typeof fetch;
    const cache = new CodexQuotaCache(config, async () => token, fetcher, () => now);
    expect(calls).toBe(0);
    await cache.refresh();
    expect(calls).toBe(1);
    expect(cache.snapshot?.fetchedAt).toBe(now);
    expect(codexAccountId("not-a-token")).toBeUndefined();
    cache.stop();
  });
  test("concurrent refreshes share one request and failures never extend freshness", async () => {
    let calls = 0;
    let time = now;
    const cache = new CodexQuotaCache(config, async () => "token", (async () => {
      calls++;
      return calls === 1 ? Response.json(payload()) : new Response("secret error body", { status: 401 });
    }) as unknown as typeof fetch, () => time);
    await Promise.all([cache.refresh(), cache.refresh()]);
    expect(calls).toBe(1);
    time += 120000;
    await cache.refresh();
    expect(cache.snapshot?.fetchedAt).toBe(now);
    expect(quotaEligibility(target, target.provider, { ...config, onUnknown: "skip" }, cache.snapshot, time).allowed).toBe(false);
    cache.stop();
  });
  test("missing credentials, rejected requests and malformed JSON are safe", async () => {
    let calls = 0;
    const noToken = new CodexQuotaCache(config, async () => undefined, (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch);
    await noToken.refresh();
    expect(calls).toBe(0);
    noToken.stop();
    for (const fetcher of [async () => { throw new Error("secret"); }, async () => new Response("not JSON")]) {
      const cache = new CodexQuotaCache(config, async () => "token", fetcher as unknown as typeof fetch);
      await cache.refresh();
      expect(cache.snapshot).toBeUndefined();
      cache.stop();
    }
  });
  test("stop aborts an in-flight request and prevents late writes and future refreshes", async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const cache = new CodexQuotaCache(config, async () => "token", (async (_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return await new Promise<Response>((resolve) => { finish = resolve; });
    }) as typeof fetch);
    const pending = cache.refresh();
    await Promise.resolve();
    cache.stop();
    expect(signal?.aborted).toBe(true);
    finish(Response.json(payload()));
    await pending;
    expect(cache.snapshot).toBeUndefined();
    await cache.refresh();
    expect(cache.snapshot).toBeUndefined();
  });
  test("the five-second deadline settles an uncooperative fetch", async () => {
    let signal: AbortSignal | undefined;
    const cache = new CodexQuotaCache(config, async () => "token", (async (_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return await new Promise<Response>(() => {});
    }) as typeof fetch);
    await cache.refresh();
    expect(signal?.aborted).toBe(true);
    expect(cache.snapshot).toBeUndefined();
    cache.stop();
  }, 7000);
  test("stop settles a refresh even when authentication never resolves", async () => {
    let calls = 0;
    const cache = new CodexQuotaCache(config, () => new Promise(() => {}), (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch);
    const pending = cache.refresh();
    cache.stop();
    await pending;
    expect(calls).toBe(0);
    expect(cache.snapshot).toBeUndefined();
  });
  test("background polling refreshes without a turn and stops on shutdown", async () => {
    let calls = 0;
    const cache = new CodexQuotaCache({ ...config, cacheTtlSec: 1 }, async () => "token", (async () => { calls++; return Response.json(payload()); }) as unknown as typeof fetch);
    cache.start();
    cache.start(); // Idempotent even while the initial request is pending.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(calls).toBe(2);
    cache.stop();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(calls).toBe(2);
  });
});
