import { describe, expect, test } from "bun:test";
import { parseZaiUsage, zaiQuotaEligibility, ZaiQuotaCache } from "../extensions/pi-jev-model-router/zai-quota";
import type { ZaiQuotaConfig } from "../extensions/pi-jev-model-router/config";

function config(overrides: Partial<ZaiQuotaConfig> = {}): ZaiQuotaConfig {
  return { enabled: true, cacheTtlSec: 120, onUnknown: "use", minQuota: { fiveHour: 0.1 }, ...overrides };
}

/** A row shaped like the live endpoint: type, unit, number and percentage. */
function row(overrides: Record<string, unknown> = {}) {
  return { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0, ...overrides };
}

function payload(used: number, nextResetTime?: number) {
  return { data: { limits: [row({ percentage: used, nextResetTime })] } };
}

describe("parseZaiUsage", () => {
  test("the 5h token meter becomes the fiveHour window with a remaining ratio", () => {
    const snapshot = parseZaiUsage(payload(40), 1000);
    expect(snapshot.fetchedAt).toBe(1000);
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.6);
  });

  test("ignores other meters, durations and rows without a percentage", () => {
    const snapshot = parseZaiUsage({ data: { limits: [
      row(),
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 },
      { unit: 3 },
      row({ percentage: 90 }),
    ] } }, 1000);
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.1);
  });

  test("a later row for another meter or duration never overwrites the token reading", () => {
    const snapshot = parseZaiUsage({ data: { limits: [
      row({ percentage: 100 }),
      { type: "TIME_LIMIT", unit: 3, number: 1, percentage: 5 },
      row({ number: 1, percentage: 5 }),
    ] } }, 1000);
    expect(snapshot.windows.fiveHour?.remaining).toBe(0);
  });

  test("a repeated 5h row keeps the more conservative reading", () => {
    const snapshot = parseZaiUsage({ data: { limits: [row({ percentage: 100 }), row({ percentage: 95 })] } }, 1000);
    expect(snapshot.windows.fiveHour?.remaining).toBe(0);
  });

  test("clamps an over-100 percentage to zero remaining instead of dropping it", () => {
    const snapshot = parseZaiUsage(payload(105), 1000);
    expect(snapshot.windows.fiveHour?.remaining).toBe(0);
    const result = zaiQuotaEligibility({ provider: "zai", model: "glm-5.4", minQuota: { fiveHour: 0.2 } }, config(), snapshot, 1000);
    expect(result.allowed).toBe(false);
  });

  test("treats nextResetTime as seconds under 1e11 and milliseconds above", () => {
    expect(parseZaiUsage(payload(50, 1700000000), 1000).windows.fiveHour?.resetAt).toBe(1700000000 * 1000);
    expect(parseZaiUsage(payload(50, 1700000000000), 1000).windows.fiveHour?.resetAt).toBe(1700000000000);
  });
});

describe("zaiQuotaEligibility", () => {
  const target = { provider: "zai", model: "glm-5.4", minQuota: { fiveHour: 0.2 } };

  test("disabled reader always allows", () => {
    expect(zaiQuotaEligibility(target, { ...config(), enabled: false }, undefined)).toEqual({ allowed: true, notes: [] });
  });

  test("skips when the 5h remaining is below the stricter floor", () => {
    const snapshot = parseZaiUsage(payload(85), 0); // 15% remaining < 20% target floor
    const result = zaiQuotaEligibility(target, config(), snapshot, 1000);
    expect(result.allowed).toBe(false);
    expect(result.notes[0]).toContain("zai 5h 15.0% < 20.0%");
  });

  test("admits when remaining clears the floor", () => {
    const snapshot = parseZaiUsage(payload(50), 0);
    expect(zaiQuotaEligibility(target, config(), snapshot, 1000).allowed).toBe(true);
  });

  test("unknown reading follows onUnknown", () => {
    expect(zaiQuotaEligibility(target, config({ onUnknown: "use" }), undefined, 1000).allowed).toBe(true);
    expect(zaiQuotaEligibility(target, config({ onUnknown: "skip" }), undefined, 1000).allowed).toBe(false);
  });
});

describe("ZaiQuotaCache credentials", () => {
  test("a changed or missing key drops the previous account's reading before the request", async () => {
    let token: string | undefined = "key-a";
    let calls = 0;
    const cache = new ZaiQuotaCache(config(), async () => token, (async () => {
      calls++;
      return calls === 1 ? Response.json(payload(5)) : new Response("secret error body", { status: 401 });
    }) as unknown as typeof fetch, () => 1000);
    await cache.refresh();
    expect(cache.snapshot?.windows.fiveHour?.remaining).toBeCloseTo(0.95);

    token = "key-b";
    await cache.refresh();
    expect(cache.snapshot).toBeUndefined();
    expect(cache.lastError).toContain("401");

    // A missing key clears the reading without a request or a reused snapshot.
    token = "key-b";
    await cache.refresh();
    token = undefined;
    await cache.refresh();
    expect(cache.snapshot).toBeUndefined();
    expect(cache.lastError).toContain("no zai credentials");
    cache.stop();
  });
});
