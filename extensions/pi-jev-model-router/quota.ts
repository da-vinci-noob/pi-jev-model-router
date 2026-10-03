import { QUOTA_WINDOWS, type CodexQuotaConfig, type QuotaWindow, type RouteTarget } from "./config";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export interface QuotaReading {
  remaining: number;
  /** Unix time in milliseconds. A past reset invalidates the reading, not the floor. */
  resetAt?: number;
}
export interface QuotaSnapshot {
  fetchedAt: number;
  windows: Partial<Record<QuotaWindow, QuotaReading>>;
}
export interface QuotaEligibility { allowed: boolean; notes: string[] }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Window duration, not primary/secondary position, determines its meaning. */
export function parseCodexUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
  const limits = record(record(payload).rate_limit);
  const windows: QuotaSnapshot["windows"] = {};
  for (const value of [limits.primary_window, limits.secondary_window]) {
    const raw = record(value);
    const window = raw.limit_window_seconds === 18000 ? "fiveHour"
      : raw.limit_window_seconds === 604800 ? "weekly" : undefined;
    const used = raw.used_percent;
    if (!window || typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const reset = raw.reset_at;
    const reading: QuotaReading = {
      remaining: (100 - used) / 100,
      resetAt: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
    };
    // If a response repeats a window, keep the more conservative reading.
    if (!windows[window] || reading.remaining < windows[window]!.remaining) windows[window] = reading;
  }
  return { fetchedAt: now, windows };
}

export function quotaEligibility(
  target: RouteTarget,
  provider: string,
  config: CodexQuotaConfig | undefined,
  snapshot: QuotaSnapshot | undefined,
  now = Date.now(),
): QuotaEligibility {
  if (provider !== "openai-codex" || !config?.enabled) return { allowed: true, notes: [] };
  let allowed = true;
  const notes: string[] = [];
  for (const window of QUOTA_WINDOWS) {
    const floor = Math.max(config.minQuota[window] ?? 0, target.minQuota?.[window] ?? 0);
    if (floor <= 0) continue;
    const reading = snapshot?.windows[window];
    const fresh = snapshot && now >= snapshot.fetchedAt && now - snapshot.fetchedAt < config.cacheTtlSec * 1000;
    const known = fresh && reading && (reading.resetAt === undefined || now < reading.resetAt);
    if (!known) {
      const skip = config.onUnknown === "skip";
      if (skip) allowed = false;
      notes.push(`${target.model} ${skip ? "skipped" : "admitted"}: codex ${window} quota unknown (missing, stale, or reset); onUnknown=${config.onUnknown}`);
    } else if (reading.remaining < floor) {
      allowed = false;
      notes.push(`${target.model} skipped: codex ${window} ${(reading.remaining * 100).toFixed(1)}% < ${(floor * 100).toFixed(1)}%`);
    }
  }
  return { allowed, notes };
}

/** Decode only to select the account header; the server validates the token. */
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = record(record(payload)["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

/** Session-owned background cache. No timers or requests are started by construction. */
export class CodexQuotaCache {
  snapshot?: QuotaSnapshot;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private stopped = false;
  private started = false;

  constructor(
    readonly config: CodexQuotaConfig,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const timeout = setTimeout(() => this.controller?.abort(), 5000);
    timeout.unref?.();
    this.pending = (async () => {
      let onAbort: () => void = () => {};
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("quota refresh aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const read = async () => {
          const token = await this.getToken();
          if (!token || signal.aborted || this.stopped) return;
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
          const account = codexAccountId(token);
          if (account) headers["ChatGPT-Account-Id"] = account;
          const response = await this.fetcher(CODEX_USAGE_URL, { headers, signal, redirect: "error" });
          if (!response.ok) return;
          const snapshot = parseCodexUsage(await response.json(), this.now());
          if (!signal.aborted && !this.stopped) this.snapshot = snapshot;
        };
        await Promise.race([read(), cancelled]);
      } catch {
        // Never include HTTP bodies, tokens, or provider errors in diagnostics.
        // An old reading retains its original timestamp and expires normally.
      } finally {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(timeout);
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    const poll = async () => {
      await this.refresh();
      if (this.stopped) return;
      const now = this.now();
      const resets = Object.values(this.snapshot?.windows ?? {}).map((w) => w.resetAt).filter((t): t is number => t !== undefined && t > now);
      const delay = Math.max(1000, Math.min(this.config.cacheTtlSec * 1000, ...resets.map((t) => t - now)));
      this.timer = setTimeout(() => { this.timer = undefined; void poll(); }, delay);
      this.timer.unref?.();
    };
    void poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
}
