import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Require the failed model's identity and an explicit withdrawal, not a bare HTTP status. */
export function isModelUnavailable(error: string, model: string): boolean {
  if (!model || !error.includes(model)) return false;
  if (/\b(?:401|403|429|5\d\d)\b|auth|access|permission|forbidden|api.?key|context|token limit|abort|cancel|temporar|overload|rate.limit/i.test(error)) return false;
  return /model_not_found|model[^\n]*(?:not found|does not exist|no longer available|decommissioned|retired|withdrawn)|(?:decommissioned|retired|withdrawn)[^\n]*model/i.test(error);
}

/**
 * A provider rate limit is attached to the request that hit it, so the caller
 * parks the resolved provider/model. A whole-provider ban would be wrong when
 * the limit is per model. Token, context and payload size limits are capacity
 * errors, not rate limits, and must not park a model.
 */
export function isRateLimited(error: string): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  if (/token limit|tokens? (?:limit|per)|context (?:length|window|limit)|max[ _-]?tokens|output limit|input limit|payload too large|request too large/.test(text)) return false;
  return /\b429\b|rate[ _-]?limit|too many requests|quota (?:exceeded|reached|exhausted|limit)|(?:usage|spend|request) limit|exceeded (?:your|the) limit/i.test(text);
}

/** Ban lengths as fractions of the configured cap (24h by default): 15m, 1h, 4h, 12h, 24h. */
const RATE_LIMIT_FRACTIONS = [1 / 96, 1 / 24, 1 / 6, 1 / 2, 1] as const;

/** Duration of the nth consecutive rate-limit park, clamped to the cap. */
export function rateLimitParkMs(capMs: number, strike: number): number {
  const index = Math.min(Math.max(Math.floor(strike), 1), RATE_LIMIT_FRACTIONS.length) - 1;
  return Math.max(1, Math.round(capMs * RATE_LIMIT_FRACTIONS[index]));
}

interface ParkEntry {
  until: number;
  strikes: number;
}

export class Parking {
  private readonly entries = new Map<string, ParkEntry>();
  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.parks)) return;
      for (const park of data.parks) {
        if (typeof park?.key !== "string" || !park.key.includes("/") ||
            typeof park.until !== "number" || !Number.isFinite(park.until) || park.until > 8.64e15) continue;
        const strikes = typeof park.strikes === "number" && Number.isFinite(park.strikes) && park.strikes >= 0
          ? Math.min(Math.floor(park.strikes), RATE_LIMIT_FRACTIONS.length) : 0;
        this.entries.set(park.key, { until: park.until, strikes });
      }
    } catch { /* Missing or corrupt state means no known parks. */ }
  }
  has(key: string, now = Date.now()): boolean {
    return (this.entries.get(key)?.until ?? 0) > now;
  }
  list(now = Date.now()): string[] {
    return [...this.entries].filter(([, entry]) => entry.until > now)
      .map(([key, entry]) => `${key} parked until ${new Date(entry.until).toISOString()}${entry.strikes ? ` (rate-limit strike ${entry.strikes})` : ""}`);
  }
  park(key: string, parkMs: number, now = Date.now()): boolean {
    this.entries.set(key, { until: Math.min(8.64e15, now + parkMs), strikes: 0 });
    return this.save(now);
  }
  /** Escalate per model: each consecutive rate limit parks longer, capped at capMs. */
  rateLimit(key: string, capMs: number, now = Date.now()): number | undefined {
    const previous = this.entries.get(key);
    const strikes = Math.min((previous?.strikes ?? 0) + 1, RATE_LIMIT_FRACTIONS.length);
    const parkMs = rateLimitParkMs(capMs, strikes);
    this.entries.set(key, { until: Math.min(8.64e15, now + parkMs), strikes });
    return this.save(now) ? parkMs : undefined;
  }
  /** A successful turn on this model clears its rate-limit streak. */
  clearStrikes(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || !entry.strikes) return true;
    if (entry.until > Date.now()) this.entries.set(key, { until: entry.until, strikes: 0 });
    else this.entries.delete(key);
    return this.save();
  }
  clear(): boolean {
    this.entries.clear();
    return this.save();
  }
  private save(now = Date.now()): boolean {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const parks = [...this.entries].filter(([, entry]) => entry.until > now)
        .map(([key, entry]) => ({ key, ...entry }));
      writeFileSync(temp, JSON.stringify({ version: 1, parks }), { mode: 0o600 });
      renameSync(temp, this.file);
      return true;
    } catch { return false; }
    finally { try { rmSync(temp, { force: true }); } catch { /* Best-effort cleanup. */ } }
  }
}
