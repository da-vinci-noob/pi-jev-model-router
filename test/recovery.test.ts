import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isModelUnavailable, Parking } from "../extensions/pi-jev-model-router/recovery";

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
