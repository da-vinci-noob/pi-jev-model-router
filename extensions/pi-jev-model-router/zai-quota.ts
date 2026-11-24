import type { RouteTarget, ZaiQuotaConfig } from "./config";
import type { QuotaEligibility, QuotaSnapshot } from "./quota";

/** Z.AI coding-plan usage endpoint. Unit 3 is the 5h token window. */
export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `nextResetTime` is seconds on older plans and milliseconds on newer ones. */
function resetAtMs(value: unknown): number | undefined {
  const raw = finiteNumber(value);
  if (raw === undefined || raw <= 0) return undefined;
  return raw > 1e11 ? raw : raw * 1000;
}

/**
 * Parse the Z.AI usage payload into the shared snapshot shape. Only the 5h
 * token window (unit 3) is read: the lite plan reports no weekly token window,
 * and unit 5 is a monthly time limit, not a token quota.
 */
export function parseZaiUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
  const limits = record(record(payload).data).limits;
  const windows: QuotaSnapshot["windows"] = {};
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const row = record(entry);
      if (finiteNumber(row.unit) !== 3) continue;
      const used = finiteNumber(row.percentage);
      if (used === undefined || used < 0 || used > 100) continue;
      windows.fiveHour = {
        remaining: (100 - used) / 100,
        resetAt: resetAtMs(row.nextResetTime),
      };
    }
  }
  return { fetchedAt: now, windows };
}

export function zaiQuotaEligibility(
  target: RouteTarget,
  config: ZaiQuotaConfig | undefined,
  snapshot: QuotaSnapshot | undefined,
  now = Date.now(),
): QuotaEligibility {
  if (!config?.enabled) return { allowed: true, notes: [] };
  const floor = Math.max(config.minQuota.fiveHour ?? 0, target.minQuota?.fiveHour ?? 0);
  if (floor <= 0) return { allowed: true, notes: [] };
  const fresh = snapshot !== undefined && now >= snapshot.fetchedAt && now - snapshot.fetchedAt < config.cacheTtlSec * 1000;
  const reading = snapshot?.windows.fiveHour;
  const known = fresh && reading && (reading.resetAt === undefined || now < reading.resetAt);
  if (!known) {
    const skip = config.onUnknown === "skip";
    return {
      allowed: !skip,
      notes: [`${target.model} ${skip ? "skipped" : "admitted"}: zai 5h quota unknown (missing, stale, or reset); onUnknown=${config.onUnknown}`],
    };
  }
  if (reading.remaining < floor) {
    return {
      allowed: false,
      notes: [`${target.model} skipped: zai 5h ${(reading.remaining * 100).toFixed(1)}% < ${(floor * 100).toFixed(1)}%`],
    };
  }
  return { allowed: true, notes: [] };
}

function span(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function isFresh(config: ZaiQuotaConfig, snapshot: QuotaSnapshot, now: number): boolean {
  return now >= snapshot.fetchedAt && now - snapshot.fetchedAt < config.cacheTtlSec * 1000;
}

/** One line for `/jev-router status`. */
export function zaiQuotaSummary(
  config: ZaiQuotaConfig | undefined,
  snapshot: QuotaSnapshot | undefined,
  lastError?: string,
  now = Date.now(),
): string {
  if (!config) return "quota: zai not configured";
  if (!config.enabled) return "quota: zai off";
  if (!snapshot) return `quota: zai on, no reading yet${lastError ? ` (${lastError})` : ""}`;
  const reading = snapshot.windows.fiveHour;
  const parts = reading
    ? [`5h ${(reading.remaining * 100).toFixed(1)}%${reading.resetAt !== undefined && now >= reading.resetAt ? " (reset: unknown)" : ""}`]
    : [];
  parts.push(isFresh(config, snapshot, now) ? "fresh" : "stale");
  return `quota: zai ${parts.join(" / ")}`;
}

/** Full picture for `/jev-router quota`. */
export function describeZaiQuotaStatus(
  config: ZaiQuotaConfig | undefined,
  snapshot: QuotaSnapshot | undefined,
  lastError?: string,
  now = Date.now(),
): string[] {
  if (!config) return ["zai quota: not configured (add quota.zai to enable the reader)"];
  if (!config.enabled) return ["zai quota: disabled (quota.zai.enabled is false)"];
  const floor = config.minQuota.fiveHour ?? 0;
  const lines = [`zai quota: on (ttl ${config.cacheTtlSec}s, onUnknown ${config.onUnknown})`];
  if (!snapshot) {
    lines.push("reading: none yet (startup stays unknown until the first fetch lands)");
  } else {
    const reading = snapshot.windows.fiveHour;
    const suffix = floor > 0 ? `, floor ${(floor * 100).toFixed(1)}%` : "";
    if (!reading) {
      lines.push(`fiveHour: no reading${suffix}`);
    } else {
      const resetPassed = reading.resetAt !== undefined && reading.resetAt <= now;
      const reset = reading.resetAt === undefined ? "" : `, resets in ${span(reading.resetAt - now)}${resetPassed ? " (reset passed)" : ""}`;
      lines.push(`fiveHour: ${(reading.remaining * 100).toFixed(1)}% remaining${reset}${suffix}`);
    }
    const fresh = isFresh(config, snapshot, now);
    lines.push(`reading: ${fresh ? "fresh" : "stale"} (age ${span(Math.abs(now - snapshot.fetchedAt))}${fresh ? "" : `, ttl ${config.cacheTtlSec}s`})`);
    if (!fresh) lines.push(`  a stale reading is treated as unknown; onUnknown=${config.onUnknown}`);
  }
  if (lastError) lines.push(`last error: ${lastError}`);
  return lines;
}

/** Session-owned background cache. No timers or requests are started by construction. */
export class ZaiQuotaCache {
  snapshot?: QuotaSnapshot;
  /** Last refresh failure, safe to display: never contains tokens or response bodies. */
  lastError?: string;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private stopped = false;
  private started = false;
  private readonly initialization = Promise.withResolvers<void>();
  /** Resolves after credential validation, without waiting for the usage HTTP response. */
  readonly ready = this.initialization.promise;

  constructor(
    readonly config: ZaiQuotaConfig,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private fail(message: string): void {
    // Repeated identical failures (a missing token on every poll) do not spam.
    if (this.lastError === message) return;
    this.lastError = message;
  }

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
          onAbort = () => reject(new Error("zai quota refresh aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const read = async () => {
          const token = await this.getToken();
          if (signal.aborted || this.stopped) return;
          this.initialization.resolve();
          if (!token) {
            this.fail("no zai credentials for the quota endpoint");
            return;
          }
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
          const response = await this.fetcher(ZAI_QUOTA_URL, { headers, signal, redirect: "error" });
          if (signal.aborted || this.stopped) return;
          if (!response.ok) {
            this.fail(`quota endpoint returned HTTP ${response.status}`);
            return;
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            this.fail("quota endpoint did not return JSON");
            return;
          }
          if (signal.aborted || this.stopped) return;
          this.snapshot = parseZaiUsage(payload, this.now());
          this.lastError = undefined;
        };
        await Promise.race([read(), cancelled]);
      } catch {
        // Never include HTTP bodies, tokens, or provider errors in diagnostics.
        if (!this.stopped) {
          this.snapshot = undefined;
          this.fail(signal.aborted ? "quota request timed out" : "quota request failed");
        }
      } finally {
        this.initialization.resolve();
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
      const reset = this.snapshot?.windows.fiveHour?.resetAt;
      const nextReset = reset !== undefined && reset > now ? reset - now : Number.POSITIVE_INFINITY;
      const delay = Math.max(1000, Math.min(this.config.cacheTtlSec * 1000, nextReset));
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
