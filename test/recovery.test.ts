import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isModelUnavailable, isRateLimited, Parking, rateLimitParkMs } from "../extensions/pi-jev-model-router/recovery";

describe("escalating rate-limit bans", () => {
  test("starts at 15m and escalates to 1h, 4h, 12h and 24h", () => {
    const cap = 86_400_000;
    for (const [strike, expected] of [[1, 900_000], [2, 3_600_000], [3, 14_400_000], [4, 43_200_000], [5, cap], [9, cap]]) {
      expect(rateLimitParkMs(cap, strike)).toBe(expected);
    }
  });
  test("an expired park stays eligible but keeps its strike across unrelated saves and restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-expired-strikes-"));
    try {
      const path = join(dir, "state.json.recovery.json");
      const cap = 86_400_000;
      const parks = new Parking(path);
      const later = 901_001;
      expect(parks.rateLimit("a/beam-free", cap, 1000)).toBe(900_000);
      parks.rateLimit("a/other-free", cap, later);
      const restored = new Parking(path);
      expect(restored.has("a/beam-free", later)).toBe(false);
      expect(restored.rateLimit("a/beam-free", cap, later)).toBe(3_600_000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("the streak is per model, survives restart, and clears after a success", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-escalation-"));
    try {
      const path = join(dir, "state.json.recovery.json");
      const cap = 86_400_000;
      const parks = new Parking(path);
      for (const expected of [900_000, 3_600_000, 14_400_000, 43_200_000, cap, cap]) {
        expect(parks.rateLimit("a/std-a", cap, 1000)).toBe(expected);
      }
      expect(parks.rateLimit("b/std-a", cap, 1000)).toBe(900_000);
      const restored = new Parking(path);
      expect(restored.rateLimit("a/std-a", cap, 1000)).toBe(cap);
      restored.clearStrikes("a/std-a");
      expect(restored.rateLimit("a/std-a", cap, 1000)).toBe(900_000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("rate-limit parking", () => {
  test("recognizes provider rate limits but not capacity or withdrawal errors", () => {
    for (const error of [
      "429", "429 Too Many Requests", "rate limit exceeded for model std-a",
      "rate_limit_error: slow down", "RateLimitError: too many requests",
      "quota exceeded for this API key", "usage limit reached", "You have hit your usage limit",
      "429 Too Many Requests: rate limit of 10,000 tokens per minute exceeded",
      "429: token limit exceeded (10,000 tokens per minute)",
    ]) {
      expect(isRateLimited(error)).toBe(true);
    }
    for (const error of [
      "model_not_found: std-a", "500 internal server error", "401 invalid API key",
      "context length exceeded for std-a", "token limit reached", "max_tokens exceeded", "aborted",
      "429: 10,000 tokens per request exceeded", "429: context window too large",
    ]) {
      expect(isRateLimited(error)).toBe(false);
    }
  });
  test("a park is scoped to the resolved provider/model", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-ratelimit-"));
    try {
      const path = join(dir, "state.json.recovery.json");
      const parks = new Parking(path);
      parks.park("a/std-a", 86_400_000, 1000);
      expect(parks.has("a/std-a", 1000 + 86_400_000 - 1)).toBe(true);
      expect(parks.has("b/std-a", 1000 + 1)).toBe(false);
      expect(parks.has("a/std-b", 1000 + 1)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
describe("unavailable-model recovery", () => {
  test("only parks explicit model withdrawal, not unrelated failures", () => {
    for (const error of ["model_not_found: std-a", "The model `std-a` has been decommissioned", "Model std-a is no longer available"]) {
      expect(isModelUnavailable(error, "std-a")).toBe(true);
    }
    for (const error of ["404 Not Found", "model_not_found: other", "401 model std-a not found", "429 model std-a unavailable", "500 model std-a unavailable", "context length exceeded for std-a", "aborted", "invalid API key for std-a", "Model std-a does not exist or you do not have access to it", "model std-a is temporarily unavailable"]) {
      expect(isModelUnavailable(error, "std-a")).toBe(false);
    }
  });
  test("parking survives restart, remains provider-scoped, expires, and clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-recovery-"));
    try {
      const path = join(dir, "state.json.recovery.json");
      const parks = new Parking(path);
      parks.park("a/std-a", 100, 1000);
      const restored = new Parking(path);
      expect(restored.has("a/std-a", 1099)).toBe(true);
      expect(restored.has("b/std-a", 1099)).toBe(false);
      expect(restored.has("a/std-a", 1100)).toBe(false);
      restored.clear();
      expect(new Parking(path).has("a/std-a", 1050)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
