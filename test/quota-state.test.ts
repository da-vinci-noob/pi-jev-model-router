import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexQuotaConfig } from "../extensions/pi-jev-model-router/config";
import { CodexQuotaCache, loadQuotaState, quotaEligibility } from "../extensions/pi-jev-model-router/quota";

const now = 1_800_000_000_000;
const config: CodexQuotaConfig = { enabled: true, cacheTtlSec: 120, onUnknown: "skip", minQuota: { fiveHour: 0.2 } };
const target = { provider: "openai-codex", model: "guarded" };
const payload = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: now / 1000 + 600 } } };
function token(account: string, signature = "signature"): string {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.${signature}`;
}

describe("quota account isolation and reset safety", () => {
  test("an expired hard-stop reset follows unknown policy without waiving other known floors", () => {
    const snapshot = {
      fetchedAt: now - 2000, limitReached: true, windows: {
        fiveHour: { remaining: 0.9, resetAt: now }, weekly: { remaining: 0.9, resetAt: now + 100000 },
      }
    };
    for (const onUnknown of ["use", "skip"] as const) {
      const result = quotaEligibility(target, target.provider, { ...config, onUnknown }, snapshot, now);
      expect(result.allowed).toBe(onUnknown === "use");
      expect(result.notes.join(" ")).toContain("unknown");
    }
    snapshot.windows.weekly.remaining = 0.01;
    expect(quotaEligibility({ ...target, minQuota: { weekly: 0.2 } }, target.provider, { ...config, onUnknown: "use" }, snapshot, now).allowed).toBe(false);
  });

  test("a persisted reading is not exposed before identity validation or reused for another account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-quota-account-"));
    const file = join(dir, "quota.json");
    const writer = new CodexQuotaCache(config, async () => token("A"), (async () => Response.json(payload)) as unknown as typeof fetch, () => now, { stateFile: file });
    let reader: CodexQuotaCache | undefined;
    try {
      await writer.refresh();
      reader = new CodexQuotaCache(config, async () => token("B"), (async () => new Response(null, { status: 503 })) as unknown as typeof fetch, () => now, { stateFile: file });
      expect(reader.snapshot).toBeUndefined();
      await reader.refresh();
      expect(reader.snapshot).toBeUndefined();
      expect(quotaEligibility(target, target.provider, config, reader.snapshot, now).allowed).toBe(false);
      expect(readFileSync(file, "utf8")).not.toContain(token("A"));
    } finally { writer.stop(); reader?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("switching accounts or losing credentials invalidates a live reading before a failed refresh", async () => {
    let currentToken: string | undefined = token("A");
    let good = true;
    const cache = new CodexQuotaCache(config, async () => currentToken, (async () => good ? Response.json(payload) : new Response(null, { status: 503 })) as unknown as typeof fetch, () => now);
    try {
      await cache.refresh();
      expect(quotaEligibility(target, target.provider, config, cache.snapshot, now).allowed).toBe(true);
      currentToken = token("B"); good = false;
      await cache.refresh();
      expect(cache.snapshot).toBeUndefined();
      good = true;
      await cache.refresh();
      currentToken = undefined;
      await cache.refresh();
      expect(cache.snapshot).toBeUndefined();
    } finally { cache.stop(); }
  });

  test("same-account token rotation restores before HTTP completes without extending freshness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-quota-ready-"));
    const file = join(dir, "quota.json");
    const writer = new CodexQuotaCache(config, async () => token("A"), (async () => Response.json(payload)) as unknown as typeof fetch, () => now, { stateFile: file });
    const response = Promise.withResolvers<Response>();
    let reader: CodexQuotaCache | undefined;
    try {
      await writer.refresh();
      reader = new CodexQuotaCache(config, async () => token("A", "rotated"), (async () => response.promise) as unknown as typeof fetch, () => now + 1000, { stateFile: file });
      reader.start();
      await reader.ready;
      expect(reader.restored).toBe(true);
      expect(reader.snapshot?.fetchedAt).toBe(now);
      expect(quotaEligibility(target, target.provider, config, reader.snapshot, now + 1000).allowed).toBe(true);
      expect(loadQuotaState(file).snapshot?.fetchedAt).toBe(now);
    } finally { response.resolve(new Response(null, { status: 503 })); writer.stop(); reader?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("refresh diagnostics do not persist arbitrary error names", async () => {
    const error = new Error("secret-body");
    error.name = "secret-token";
    const cache = new CodexQuotaCache(config, async () => token("A"), (async () => { throw error; }) as unknown as typeof fetch, () => now);
    try {
      await cache.refresh();
      expect(cache.lastError).toBe("usage request failed");
    } finally { cache.stop(); }
  });
});
