import { describe, expect, test } from "bun:test";
import { parseZaiUsage, zaiQuotaEligibility } from "../extensions/pi-jev-model-router/zai-quota";
import type { ZaiQuotaConfig } from "../extensions/pi-jev-model-router/config";

function config(overrides: Partial<ZaiQuotaConfig> = {}): ZaiQuotaConfig {
  return { enabled: true, cacheTtlSec: 120, onUnknown: "use", minQuota: { fiveHour: 0.1 }, ...overrides };
}

function payload(used: number, unit = 3, nextResetTime?: number) {
  return { data: { limits: [{ type: "TOKENS_LIMIT", unit, percentage: used, nextResetTime }] } };
}

describe("parseZaiUsage", () => {
  test("unit 3 becomes the fiveHour window with a remaining ratio", () => {
    const snapshot = parseZaiUsage(payload(40), 1000);
    expect(snapshot.fetchedAt).toBe(1000);
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.6);
  });

  test("ignores non-5h units and rows without a percentage", () => {
    const snapshot = parseZaiUsage({ data: { limits: [
      { unit: 5, percentage: 10 },
      { unit: 3 },
      { unit: 3, percentage: 90 },
    ] } }, 1000);
    expect(snapshot.windows.fiveHour?.remaining).toBeCloseTo(0.1);
  });

  test("treats nextResetTime as seconds under 1e11 and milliseconds above", () => {
    expect(parseZaiUsage(payload(50, 3, 1700000000), 1000).windows.fiveHour?.resetAt).toBe(1700000000 * 1000);
    expect(parseZaiUsage(payload(50, 3, 1700000000000), 1000).windows.fiveHour?.resetAt).toBe(1700000000000);
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
