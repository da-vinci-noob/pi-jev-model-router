import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Require the failed model's identity and an explicit withdrawal, not a bare HTTP status. */
export function isModelUnavailable(error: string, model: string): boolean {
  if (!model || !error.includes(model)) return false;
  if (/\b(?:401|403|429|5\d\d)\b|auth|access|permission|forbidden|api.?key|context|token limit|abort|cancel|temporar|overload|rate.limit/i.test(error)) return false;
  return /model_not_found|model[^\n]*(?:not found|does not exist|no longer available|decommissioned|retired|withdrawn)|(?:decommissioned|retired|withdrawn)[^\n]*model/i.test(error);
}

export class Parking {
  private readonly entries = new Map<string, number>();
  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.parks)) return;
      for (const park of data.parks) {
        if (typeof park?.key === "string" && park.key.includes("/") && typeof park.until === "number" && Number.isFinite(park.until) && park.until <= 8.64e15) {
          this.entries.set(park.key, park.until);
        }
      }
    } catch { /* Missing or corrupt state means no known parks. */ }
  }
  has(key: string, now = Date.now()): boolean {
    return (this.entries.get(key) ?? 0) > now;
  }
  list(now = Date.now()): string[] {
    return [...this.entries].filter(([, until]) => until > now)
      .map(([key, until]) => `${key} parked until ${new Date(until).toISOString()}`);
  }
  park(key: string, parkMs: number, now = Date.now()): boolean {
    this.entries.set(key, Math.min(8.64e15, now + parkMs));
    return this.save(now);
  }
  clear(): boolean {
    this.entries.clear();
    return this.save();
  }
  private save(now = Date.now()): boolean {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const parks = [...this.entries].filter(([, until]) => until > now).map(([key, until]) => ({ key, until }));
      writeFileSync(temp, JSON.stringify({ version: 1, parks }), { mode: 0o600 });
      renameSync(temp, this.file);
      return true;
    } catch { return false; }
    finally { try { rmSync(temp, { force: true }); } catch { /* Best-effort cleanup. */ } }
  }
}
