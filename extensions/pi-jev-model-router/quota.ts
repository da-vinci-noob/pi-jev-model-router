import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /** The endpoint reports the account cannot serve requests until a window resets. */
  limitReached?: boolean;
}
export interface QuotaEligibility { allowed: boolean; notes: string[] }

/** A reading plus what the last refresh attempt did, persisted between sessions. */
export interface QuotaCacheState {
  version: 1;
  snapshot?: QuotaSnapshot;
  lastError?: string;
  updatedAt: number;
  /** Stable account fingerprint, or credential fingerprint when the token has no account claim. */
  accountKey?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  // `limit_reached` is a provider-level hard stop, so it outranks a healthy ratio.
  const limitReached = limits.limit_reached === true || limits.allowed === false;
  return { fetchedAt: now, windows, ...(limitReached ? { limitReached: true } : {}) };
}

export function quotaEligibility(
  target: RouteTarget,
  provider: string,
  config: CodexQuotaConfig | undefined,
  snapshot: QuotaSnapshot | undefined,
  now = Date.now(),
): QuotaEligibility {
  if (provider !== "openai-codex" || !config?.enabled) return { allowed: true, notes: [] };
  const floors = QUOTA_WINDOWS.map((window) => Math.max(config.minQuota[window] ?? 0, target.minQuota?.[window] ?? 0));
  // An ungated target is never affected, even by a hard stop: the reader is opt-in.
  if (!floors.some((floor) => floor > 0)) return { allowed: true, notes: [] };
  const fresh = snapshot !== undefined && now >= snapshot.fetchedAt && now - snapshot.fetchedAt < config.cacheTtlSec * 1000;
  const resetPassed = snapshot?.limitReached && hardLimitReset(snapshot, now);
  if (fresh && snapshot.limitReached === true && !resetPassed) {
    return { allowed: false, notes: [`${target.model} skipped: codex account limit reached (rate_limit.limit_reached)`] };
  }
  let allowed = true;
  const notes: string[] = [];
  if (fresh && resetPassed) {
    allowed = config.onUnknown !== "skip";
    notes.push(`${target.model} codex account limit unknown (reset); onUnknown=${config.onUnknown}`);
  }
  for (const window of QUOTA_WINDOWS) {
    const floor = Math.max(config.minQuota[window] ?? 0, target.minQuota?.[window] ?? 0);
    if (floor <= 0) continue;
    const reading = snapshot?.windows[window];
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

/** Readings live beside the spend ledger so a new session inherits the last fetch. */
export function quotaStatePath(stateFile: string): string {
  return `${stateFile}.quota.json`;
}

function emptyQuotaState(): QuotaCacheState {
  return { version: 1, updatedAt: 0 };
}

/** Unknown, corrupt, or unpersisted state is an empty state, never an invented reading. */
export function loadQuotaState(file: string | undefined): QuotaCacheState {
  const empty = emptyQuotaState();
  if (!file) return empty;
  try {
    const data = record(JSON.parse(readFileSync(file, "utf8")));
    if (data.version !== 1) return empty;
    const raw = record(data.snapshot);
    const lastError = typeof data.lastError === "string" && data.lastError.length > 0 ? data.lastError : undefined;
    const accountKey = typeof data.accountKey === "string" && /^[a-f0-9]{64}$/.test(data.accountKey) ? data.accountKey : undefined;
    const fetchedAt = finiteNumber(raw.fetchedAt);
    if (fetchedAt === undefined) return { ...empty, lastError, accountKey, updatedAt: finiteNumber(data.updatedAt) ?? 0 };
    const windows: QuotaSnapshot["windows"] = {};
    const rawWindows = record(raw.windows);
    for (const window of QUOTA_WINDOWS) {
      const value = record(rawWindows[window]);
      const remaining = finiteNumber(value.remaining);
      if (remaining === undefined || remaining < 0 || remaining > 1) continue;
      const resetAt = finiteNumber(value.resetAt);
      windows[window] = { remaining, resetAt: resetAt !== undefined && resetAt > 0 ? resetAt : undefined };
    }
    return {
      version: 1,
      snapshot: { fetchedAt, windows, ...(raw.limitReached === true ? { limitReached: true } : {}) },
      lastError,
      updatedAt: finiteNumber(data.updatedAt) ?? fetchedAt,
      accountKey,
    };
  } catch {
    return empty;
  }
}

export function saveQuotaState(file: string | undefined, state: QuotaCacheState): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort; routing must never break because of it.
  }
}

export interface QuotaStatusInput {
  config?: CodexQuotaConfig;
  snapshot?: QuotaSnapshot;
  lastError?: string;
  /** True while the current reading came from the previous session's file. */
  restored?: boolean;
  now?: number;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
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

function isFresh(config: CodexQuotaConfig, snapshot: QuotaSnapshot, now: number): boolean {
  return now >= snapshot.fetchedAt && now - snapshot.fetchedAt < config.cacheTtlSec * 1000;
}

function hardLimitReset(snapshot: QuotaSnapshot, now: number): boolean {
  return Object.values(snapshot.windows).some((reading) => reading.resetAt !== undefined && now >= reading.resetAt);
}

/** One line for `/jev-router status`, from state that is already in memory. */
export function quotaSummary(input: QuotaStatusInput): string {
  const config = input.config;
  if (!config) return "quota: codex not configured";
  if (!config.enabled) return "quota: codex off";
  const snapshot = input.snapshot;
  const now = input.now ?? Date.now();
  if (!snapshot) return `quota: codex on, no reading yet${input.lastError ? ` (${input.lastError})` : ""}`;
  const parts = QUOTA_WINDOWS.flatMap((window) => {
    const reading = snapshot.windows[window];
    return reading ? [`${window === "fiveHour" ? "5h" : window} ${percent(reading.remaining)}${reading.resetAt !== undefined && now >= reading.resetAt ? " (reset: unknown)" : ""}`] : [];
  });
  if (snapshot.limitReached) parts.push(isFresh(config, snapshot, now) && !hardLimitReset(snapshot, now) ? "limit reached" : "reported limit: unknown");
  const age = span(Math.abs(now - snapshot.fetchedAt));
  parts.push(isFresh(config, snapshot, now) ? `fresh (${age})` : `stale (${age})`);
  return `quota: codex ${parts.join(" / ")}`;
}

/**
 * Full picture for `/jev-router quota`: what the guard knows right now, how old
 * the reading is, and what the last refresh attempt did.
 */
export function describeQuotaStatus(input: QuotaStatusInput): string[] {
  const config = input.config;
  if (!config) return ["codex quota: not configured (add quota.openai-codex to enable the reader)"];
  if (!config.enabled) return ["codex quota: disabled (quota.openai-codex.enabled is false)"];
  const now = input.now ?? Date.now();
  const lines = [
    `codex quota: on (ttl ${config.cacheTtlSec}s, onUnknown ${config.onUnknown}, source ${input.restored ? "restored from the previous session" : "this session"})`,
  ];
  const snapshot = input.snapshot;
  if (!snapshot) {
    lines.push("reading: none yet (startup stays unknown until the first fetch lands)");
  } else {
    for (const window of QUOTA_WINDOWS) {
      const floor = config.minQuota[window] ?? 0;
      const reading = snapshot.windows[window];
      const suffix = floor > 0 ? `, floor ${percent(floor)}` : "";
      if (!reading) {
        lines.push(`${window}: no reading${suffix}`);
        continue;
      }
      const resetPassed = reading.resetAt !== undefined && reading.resetAt <= now;
      const reset = reading.resetAt === undefined ? "" : `, resets in ${span(reading.resetAt - now)}${resetPassed ? " (reset passed)" : ""}`;
      lines.push(`${window}: ${percent(reading.remaining)} remaining${reset}${suffix}`);
    }
    if (snapshot.limitReached) lines.push(isFresh(config, snapshot, now) && !hardLimitReset(snapshot, now)
      ? "limit reached: yes (rate_limit.limit_reached)"
      : `reported account limit: unknown (stale or reset); onUnknown=${config.onUnknown}`);
    const age = span(Math.abs(now - snapshot.fetchedAt));
    const fresh = isFresh(config, snapshot, now);
    lines.push(`reading: ${fresh ? "fresh" : "stale"} (age ${age}${fresh ? "" : `, ttl ${config.cacheTtlSec}s`})`);
    if (!fresh) lines.push(`  a stale reading is treated as unknown; onUnknown=${config.onUnknown}`);
  }
  if (input.lastError) lines.push(`last error: ${input.lastError}`);
  return lines;
}

/** Session-owned background cache. No timers or requests are started by construction. */
export class CodexQuotaCache {
  snapshot?: QuotaSnapshot;
  /** Last refresh failure, safe to display: never contains tokens or response bodies. */
  lastError?: string;
  /** True while the reading came from the persisted state instead of a fetch. */
  restored = false;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private stopped = false;
  private started = false;
  private accountKey?: string;
  private persisted?: QuotaCacheState;
  private readonly initialization = Promise.withResolvers<void>();
  /** Resolves after credential validation, without waiting for the usage HTTP response. */
  readonly ready = this.initialization.promise;

  constructor(
    readonly config: CodexQuotaConfig,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly options: { stateFile?: string } = {},
  ) {
    this.persisted = loadQuotaState(this.options.stateFile);
  }

  private persist(): void {
    saveQuotaState(this.options.stateFile, {
      version: 1,
      ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      updatedAt: this.now(),
      accountKey: this.accountKey,
    });
  }

  private fail(message: string): void {
    // Repeated identical failures (a missing token on every poll) do not rewrite the file.
    if (this.lastError === message) return;
    this.lastError = message;
    this.persist();
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
      let authenticated = false;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("quota refresh aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const read = async () => {
          const token = await this.getToken();
          if (signal.aborted || this.stopped) return;
          const account = token ? codexAccountId(token) : undefined;
          const accountKey = token ? createHash("sha256").update(account ? `account:${account}` : `token:${token}`).digest("hex") : undefined;
          if (this.accountKey !== accountKey || !token) {
            this.snapshot = undefined;
            this.restored = false;
            this.lastError = undefined;
          }
          this.accountKey = accountKey;
          if (accountKey && this.persisted?.accountKey === accountKey) {
            this.snapshot = this.persisted.snapshot;
            this.lastError = this.persisted.lastError;
            this.restored = this.snapshot !== undefined;
          }
          this.persisted = undefined;
          authenticated = true;
          this.initialization.resolve();
          if (!token) {
            this.fail("no openai-codex credentials for the usage endpoint");
            return;
          }
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
          // The fingerprint and account header use the same credential observation.
          if (account) headers["ChatGPT-Account-Id"] = account;
          const response = await this.fetcher(CODEX_USAGE_URL, { headers, signal, redirect: "error" });
          if (signal.aborted || this.stopped) return;
          if (!response.ok) {
            this.fail(`usage endpoint returned HTTP ${response.status}`);
            return;
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            this.fail("usage endpoint did not return JSON");
            return;
          }
          if (signal.aborted || this.stopped) return;
          this.snapshot = parseCodexUsage(payload, this.now());
          this.lastError = undefined;
          this.restored = false;
          this.persist();
        };
        await Promise.race([read(), cancelled]);
      } catch {
        // Never include HTTP bodies, tokens, or provider errors in diagnostics.
        // An old reading retains its original timestamp and expires normally.
        if (!this.stopped) {
          if (!authenticated) {
            this.snapshot = undefined;
            this.restored = false;
            this.accountKey = undefined;
            this.persisted = undefined;
          }
          this.fail(signal.aborted ? "usage request timed out" : "usage request failed");
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
