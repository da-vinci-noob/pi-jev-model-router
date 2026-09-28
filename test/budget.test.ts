import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLedger,
  formatUsd,
  loadLedger,
  recordCost,
  recordJevUsage,
  saveLedger,
  spendSnapshot,
} from "../extensions/pi-jev-model-router/budget";
import type { Ledger } from "../extensions/pi-jev-model-router/budget";
import type { BudgetConfig } from "../extensions/pi-jev-model-router/config";

const budget = (caps: Partial<BudgetConfig>): BudgetConfig => ({ softRatio: 0.7, hardRatio: 0.9, ...caps });

afterEach(() => setSystemTime());

describe("spendSnapshot", () => {
  function ledgerWith(today: number, month: number): Ledger {
    setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const ledger = emptyLedger();
    ledger.days["2026-03-15"] = { total: today, byModel: {} };
    ledger.days["2026-03-14"] = { total: 99, byModel: {} };
    ledger.months["2026-03"] = { total: month, byModel: {} };
    return ledger;
  }

  test("pressure is the max of daily and monthly cap ratios", () => {
    const ledger = ledgerWith(1, 30);
    expect(spendSnapshot(ledger, budget({ dailyUsd: 4, monthlyUsd: 100 })).pressure).toBe(0.3);
    expect(spendSnapshot(ledger, budget({ dailyUsd: 2, monthlyUsd: 100 })).pressure).toBe(0.5);
  });

  test("only the configured cap contributes and other days are ignored", () => {
    const ledger = ledgerWith(1, 30);
    const snap = spendSnapshot(ledger, budget({ dailyUsd: 2 }));
    expect(snap).toEqual({ today: 1, month: 30, pressure: 0.5, dailyCap: 2, monthlyCap: undefined });
  });

  test("no caps or non-positive caps give zero pressure", () => {
    const ledger = ledgerWith(5, 50);
    expect(spendSnapshot(ledger, budget({})).pressure).toBe(0);
    expect(spendSnapshot(ledger, budget({ dailyUsd: 0, monthlyUsd: -1 })).pressure).toBe(0);
  });

  test("empty ledger reports zero spend", () => {
    const snap = spendSnapshot(emptyLedger(), budget({ dailyUsd: 1 }));
    expect(snap.today).toBe(0);
    expect(snap.pressure).toBe(0);
  });
});

describe("recordCost", () => {
  test("accumulates per day, month and model with 4-decimal rounding", () => {
    setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const ledger = emptyLedger();
    recordCost(ledger, "testprov/model-a", 0.1);
    recordCost(ledger, "testprov/model-a", 0.2);
    recordCost(ledger, "testprov/model-b", 0.00004);
    expect(ledger.days["2026-03-15"]).toEqual({ total: 0.3, byModel: { "testprov/model-a": 0.3, "testprov/model-b": 0 } });
    expect(ledger.months["2026-03"]).toEqual(ledger.days["2026-03-15"]);
  });

  test("new day starts a fresh day bucket while the month keeps accumulating", () => {
    const ledger = emptyLedger();
    setSystemTime(new Date("2026-03-15T23:59:00Z"));
    recordCost(ledger, "testprov/model-a", 1);
    setSystemTime(new Date("2026-03-16T00:01:00Z"));
    recordCost(ledger, "testprov/model-a", 2);
    expect(ledger.days["2026-03-15"].total).toBe(1);
    expect(ledger.days["2026-03-16"].total).toBe(2);
    expect(ledger.months["2026-03"].total).toBe(3);
  });

  test("new month starts a fresh month bucket", () => {
    const ledger = emptyLedger();
    setSystemTime(new Date("2026-03-31T12:00:00Z"));
    recordCost(ledger, "testprov/model-a", 1);
    setSystemTime(new Date("2026-04-01T12:00:00Z"));
    recordCost(ledger, "testprov/model-a", 2);
    expect(ledger.months["2026-03"].total).toBe(1);
    expect(ledger.months["2026-04"].total).toBe(2);
  });

  test("ignores zero, negative and non-finite costs", () => {
    const ledger = emptyLedger();
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) recordCost(ledger, "testprov/model-a", usd);
    expect(ledger.days).toEqual({});
    expect(ledger.months).toEqual({});
  });
});

describe("ledger persistence", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("missing or corrupt file loads an empty ledger", () => {
    dir = mkdtempSync(join(tmpdir(), "jev-ledger-"));
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ nope");
    for (const file of [join(dir, "missing.json"), corrupt]) {
      const ledger = loadLedger(file);
      expect(ledger.days).toEqual({});
      expect(ledger.months).toEqual({});
      expect(ledger.jev).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0 });
    }
  });

  test("partial file is filled with empty defaults", () => {
    dir = mkdtempSync(join(tmpdir(), "jev-ledger-"));
    const file = join(dir, "partial.json");
    writeFileSync(file, JSON.stringify({ jev: { requests: 3 } }));
    const ledger = loadLedger(file);
    expect(ledger.days).toEqual({});
    expect(ledger.jev).toEqual({ requests: 3, inputTokens: 0, outputTokens: 0 });
  });

  test("saveLedger then loadLedger round-trips, creating parent dirs", () => {
    dir = mkdtempSync(join(tmpdir(), "jev-ledger-"));
    const file = join(dir, "nested", "deeper", "ledger.json");
    setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const ledger = emptyLedger();
    recordCost(ledger, "testprov/model-a", 0.25);
    recordJevUsage(ledger, 100, 5);
    recordJevUsage(ledger);
    saveLedger(file, ledger);
    const loaded = loadLedger(file);
    expect(loaded.days).toEqual(ledger.days);
    expect(loaded.months).toEqual(ledger.months);
    expect(loaded.jev).toEqual({ requests: 2, inputTokens: 100, outputTokens: 5 });
  });
});

test("formatUsd picks precision by magnitude", () => {
  expect(formatUsd(12.345)).toBe("$12.35");
  expect(formatUsd(1)).toBe("$1.00");
  expect(formatUsd(0.0567)).toBe("$0.057");
  expect(formatUsd(0.01)).toBe("$0.010");
  expect(formatUsd(0.00123)).toBe("$0.0012");
});
