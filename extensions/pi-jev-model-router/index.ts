/**
 * pi-jev-model-router — TypeSafe Jev model router for pi.
 *
 * On every user prompt: send the request to Jev (System One), get typed
 * judgments about what the work is, how hard it is, and how much capability it
 * deserves, then route the turn to the matching model tier. Code applies the
 * budget policy; Jev only judges the task.
 *
 * Commands:  /jev-router [status|on|off|mode|budget|why|revert|suggest [--write]]
 *            /jev-route <text>
 * Tool:      jev_route
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { apiKeyFor, configPaths, hasApiKey, loadConfig, TIERS, type JevRouterConfig } from "./config";
import { loadScores, suggestRoutes } from "./ranking";
import {
  formatUsd,
  loadLedger,
  recordCost,
  recordJevUsage,
  saveLedger,
  spendSnapshot,
  type Ledger,
} from "./budget";
import { classifyRequest, JevError, type RouteAnalysis } from "./jev";
import {
  decide,
  describeKindRoutes,
  describeDecision,
  findModel,
  firstAvailable,
  tierIndex,
  tierForModel,
  type AvailableModel,
  type Decision,
} from "./router";

interface Runtime {
  config: JevRouterConfig;
  ledger: Ledger;
  models: AvailableModel[];
  lastDecision?: Decision;
  lastAnalysis?: RouteAnalysis;
  lastPrompt?: string;
  previousModelKey?: string;
  appliedTierIndex?: number;
  lastEntrySignature?: string;
}

const ACK_PATTERN = /^(y|yes|yeah|yep|ok|okay|sure|continue|go on|go ahead|do it|proceed|nice|thanks|thank you|ty)[.!]?$/i;

/** Data rendered in the transcript for every routing decision (never sent to the LLM). */
interface DecisionEntry {
  action: "switched" | "kept" | "notified" | "skipped" | "rerouted";
  tier: string;
  model: string;
  kind: string;
  kindConfidence: number;
  complexity: number;
  capability: number;
  deepReasoning: number;
  demand: number;
  pressure: number;
  reason: string;
  notes: string[];
  /** Set when the router deliberately did not consult Jev for this prompt. */
  skipReason?: string;
  at: number;
}

function appendEntry(data: DecisionEntry, runtime: Runtime): void {
  // `appendEntry` is optional across pi builds and forks.
  if (!api || typeof api.appendEntry !== "function") return;
  const signature = `${data.action}|${data.skipReason ?? ""}|${data.model}|${data.reason}`;
  if (runtime.lastEntrySignature === signature) return;
  runtime.lastEntrySignature = signature;
  try {
    api.appendEntry<DecisionEntry>("jev-router-decision", data);
  } catch {
    // Durable entries are a nice-to-have; never let them break routing.
  }
}

/** ctx.ui.notify is present in every documented mode, but forks vary. */
function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // Ignore UI failures.
  }
}

/** Status-bar updates are cosmetic and optional. */
function setStatus(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui?.setStatus?.("jev-router", text);
  } catch {
    // Ignore UI failures.
  }
}

function appendDecisionEntry(
  analysis: RouteAnalysis,
  decision: Decision,
  action: DecisionEntry["action"],
  runtime: Runtime,
): void {
  const model = decision.model
    ? `${decision.model.provider}/${decision.model.id}`
    : `${decision.target.provider}/${decision.target.model}`;
  appendEntry(
    {
      action,
      tier: decision.tier,
      model,
      kind: analysis.kind,
      kindConfidence: analysis.kindConfidence,
      complexity: analysis.complexity,
      capability: analysis.budgetIntensity,
      deepReasoning: analysis.deepReasoning,
      demand: decision.demandScore,
      pressure: decision.budgetPressure,
      reason: decision.reason,
      notes: [...decision.notes],
      at: Date.now(),
    },
    runtime,
  );
}

const SKIP_REASONS: Record<string, string> = {
  acknowledgement: "acknowledgement — staying on the current model",
  "short continuation": "short continuation — staying on the current model",
  "no route available": "no configured route is available — staying on the current model",
};

/** Log prompts that were intentionally not routed, so the behaviour is never invisible. */
function appendSkipEntry(skipReason: string, ctx: ExtensionContext, runtime: Runtime): void {
  if (skipReason === "empty" || skipReason === "slash command") return;
  const model = currentModelKey(ctx) ?? "unknown";
  appendEntry(
    {
      action: "skipped",
      tier: runtime.appliedTierIndex !== undefined ? TIERS[runtime.appliedTierIndex] : "current",
      model,
      kind: skipReason,
      kindConfidence: 0,
      complexity: 0,
      capability: 0,
      deepReasoning: 0,
      demand: 0,
      pressure: spendSnapshot(runtime.ledger, runtime.config.budget).pressure,
      reason:
        SKIP_REASONS[skipReason] ??
        `${skipReason} — staying on the current model`,
      notes: [],
      skipReason,
      at: Date.now(),
    },
    runtime,
  );
}

function toAvailable(ctx: ExtensionContext): AvailableModel[] {
  try {
    const list = ctx.modelRegistry?.getAvailable?.();
    if (!Array.isArray(list)) return [];
    return list.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      cost: model.cost
        ? {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cacheRead,
            cacheWrite: model.cost.cacheWrite,
          }
        : undefined,
    }));
  } catch {
    return [];
  }
}

function currentModelKey(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function historyExcerpt(ctx: ExtensionContext, turns: number): string | undefined {
  if (turns <= 0) return undefined;
  const lines: string[] = [];
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    for (const entry of entries) {
      const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
      if (record.type !== "message" || !record.message) continue;
      const { role, content } = record.message;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentToText(content);
      if (!text) continue;
      lines.push(`${role}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
    }
  } catch {
    return undefined;
  }
  // Keep the last `turns` user-facing exchanges, newest last.
  const tail = lines.slice(-(turns * 2));
  return tail.length > 0 ? tail.join("\n") : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = part as { type?: string; text?: string };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function shouldSkip(text: string, config: JevRouterConfig, hasHistory: boolean): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("/")) return "slash command";
  if (ACK_PATTERN.test(trimmed)) return "acknowledgement";
  // Short messages in an ongoing conversation are usually continuations
  // ("do that", "what about X") and should not re-route. A short first
  // message in a fresh session is a real request and does get routed.
  if (trimmed.length < config.minPromptChars && hasHistory) return "short continuation";
  return undefined;
}

function statusLine(ctx: ExtensionContext, runtime: Runtime): void {
  const spend = spendSnapshot(runtime.ledger, runtime.config.budget);
  if (!runtime.config.enabled) {
    setStatus(ctx, "jev-router:off");
    return;
  }
  const tier = runtime.appliedTierIndex !== undefined ? TIERS[runtime.appliedTierIndex] : "on";
  const parts = [`jev-router:${tier}`];
  if (spend.today > 0) parts.push(formatUsd(spend.today));
  if (spend.pressure > 0) parts.push(`${Math.round(spend.pressure * 100)}%`);
  if (runtime.config.mode !== "auto") parts.push(runtime.config.mode);
  setStatus(ctx, parts.join(" · "));
}

async function analyse(
  prompt: string,
  ctx: ExtensionContext,
  runtime: Runtime,
): Promise<{ analysis: RouteAnalysis; decision?: Decision } | { error: string }> {
  const config = runtime.config;
  if (!hasApiKey(config)) {
    return { error: `missing API key (env ${config.apiKeyEnv})` };
  }
  if (runtime.models.length === 0) runtime.models = toAvailable(ctx);
  const spend = spendSnapshot(runtime.ledger, config.budget);
  // Context size prices the cache miss a switch would cause.
  const contextTokens = ctx.getContextUsage?.()?.tokens ?? undefined;
  const activeKey = currentModelKey(ctx);

  const analysis = await classifyRequest(
    {
      prompt,
      history: historyExcerpt(ctx, config.historyTurns),
      cwd: ctx.cwd,
      activeModel: activeKey,
      contextTokens,
      spend,
    },
    config,
    apiKeyFor(config),
    ctx.signal,
  );

  if (analysis.usage) recordJevUsage(runtime.ledger, analysis.usage.input_tokens, analysis.usage.output_tokens);
  saveLedger(config.stateFile, runtime.ledger);
  const decision = decide(analysis, config, {
    models: runtime.models,
    spend,
    contextTokens,
    current: {
      index: tierForModel(activeKey, config),
      model: runtime.models.find((model) => `${model.provider}/${model.id}` === activeKey),
    },
  });
  return { analysis, decision };
}

interface ApplyResult {
  action: "switched" | "kept" | "notified" | "skipped" | "rerouted";
  message: string;
}

interface GuardOutcome {
  /** The user declined, or the timeout policy rejected. The switch is abandoned. */
  keep: boolean;
  /** The user picked a different tier, so `decision` was rewritten in place. */
  rerouted: boolean;
}

/** The model a decision currently points at, as `provider/model`. */
function decisionModelKey(decision: Decision): string {
  const provider = decision.model ? decision.model.provider : decision.target.provider;
  const model = decision.model ? decision.model.id : decision.target.model;
  return `${provider}/${model}`;
}

/**
 * Ask before switching into a tier listed in `confirm.tiers`.
 *
 * `Y` or Enter accepts, `N` keeps the current model, `0` forces the free pool,
 * and `1` to `5` jump straight to a tier (`TIERS[0]` is `1`). Anything else is
 * treated as a decline, so a mistyped key never spends an expensive model.
 *
 * A reroute rewrites `decision` and returns so the common switch path below
 * stays the only place that switches models.
 */
async function guardTierSwitch(
  decision: Decision,
  ctx: ExtensionContext,
  runtime: Runtime,
  options: { allowPrompt?: boolean },
): Promise<GuardOutcome | undefined> {
  const { confirm } = runtime.config;
  if (options.allowPrompt === false) return undefined;
  if (!confirm.tiers.includes(decision.tier)) return undefined;
  if (typeof ctx.ui?.input !== "function") return undefined;

  const ladder = TIERS.map((tier, index) => `${index + 1} ${tier}`).join("   ");
  const answer = await ctx.ui.input(
    `Jev → ${decision.tier} (${decisionModelKey(decision)})\n${decision.reason}`,
    `Y/Enter switch · N keep · 0 free · ${ladder}`,
    confirm.timeoutMs > 0 ? { timeout: confirm.timeoutMs } : undefined,
  );

  // `undefined` is a dismiss or a timeout; an empty string is Enter, which accepts.
  if (answer === undefined) {
    if (confirm.onTimeout === "reject") return { keep: true, rerouted: false };
    return undefined;
  }

  const choice = answer.trim().toLowerCase();
  if (choice === "" || choice === "y" || choice === "yes") return undefined;
  if (choice === "0") {
    const free = runtime.config.free.enabled
      ? runtime.config.free.pool.find((t) => findModel(runtime.models, t))
      : undefined;
    const model = free ? findModel(runtime.models, free) : undefined;
    if (!free || !model) return { keep: true, rerouted: false };
    decision.model = model;
    decision.target = free;
    // The pool sits below `TIERS`, so record it at the cheapest rung.
    decision.tierIndex = 0;
    decision.notes.push("user forced the free pool");
    return { keep: false, rerouted: true };
  }

  if (/^[1-5]$/.test(choice)) {
    const tier = TIERS[Number(choice) - 1];
    const chosen = runtime.config.routes[tier].find((t) => findModel(runtime.models, t));
    const model = chosen ? findModel(runtime.models, chosen) : undefined;
    if (chosen && model) {
      decision.model = model;
      decision.target = chosen;
      decision.tier = tier;
      decision.tierIndex = tierIndex(tier);
      decision.notes.push(`user forced tier ${tier}`);
      return { keep: false, rerouted: true };
    }
  }
  return { keep: true, rerouted: false };
}

async function applyDecision(
  analysis: RouteAnalysis,
  decision: Decision,
  ctx: ExtensionContext,
  runtime: Runtime,
  options: { allowPrompt?: boolean } = {},
): Promise<ApplyResult> {
  const target = decision.model
    ? `${decision.model.provider}/${decision.model.id}`
    : `${decision.target.provider}/${decision.target.model}`;
  let headline = `Jev → ${decision.tier} (${target})`;
  let detail = `${decision.reason}${decision.notes.length ? ` · ${decision.notes.join(" · ")}` : ""}`;
  const currentKey = currentModelKey(ctx);
  const targetKey = decision.model ? `${decision.model.provider}/${decision.model.id}` : undefined;
  const keepCurrent =
    decision.held === true ||
    (runtime.config.stickiness && targetKey !== undefined && currentKey === targetKey);

  if (keepCurrent) {
    runtime.appliedTierIndex = decision.tierIndex;
    runtime.lastDecision = decision;
    runtime.lastAnalysis = analysis;
    setStatus(ctx, `jev-router:${decision.tier} ✓`);
    appendDecisionEntry(analysis, decision, "kept", runtime);
    return { action: "kept", message: `${headline} — already active` };
  }

  if (runtime.config.mode === "notify") {
    notify(ctx, `${headline}\n${detail}`, "info");
    appendDecisionEntry(analysis, decision, "notified", runtime);
    return { action: "notified", message: `${headline} (notify only)` };
  }

  // An expensive-tier approval gate, independent of `mode`. It runs before the
  // `confirm` select so a guarded tier asks once, not twice.
  const guard = await guardTierSwitch(decision, ctx, runtime, options);
  if (guard?.keep) {
    appendDecisionEntry(analysis, decision, "skipped", runtime);
    return { action: "skipped", message: "kept current model" };
  }
  if (guard?.rerouted) {
    // The target moved after the headline was built, so rebuild it for the notice.
    headline = `Jev → ${decision.tier} (${decisionModelKey(decision)})`;
    detail = `${decision.reason}${decision.notes.length ? ` · ${decision.notes.join(" · ")}` : ""}`;
  }

  // Confirm mode needs a working select prompt; otherwise fall through to auto-switch.
  if (
    runtime.config.mode === "confirm" &&
    options.allowPrompt !== false &&
    typeof ctx.ui?.select === "function"
  ) {
    const cheaper = TIERS[Math.max(0, decision.tierIndex - 1)];
    const cheaperTarget = runtime.config.routes[cheaper][0];
    const options_ = [
      `Use ${decision.tier} — ${target}`,
      `Use ${cheaper} — ${cheaperTarget.provider}/${cheaperTarget.model}`,
      `Keep ${currentModelKey(ctx) ?? "current model"}`,
    ];
    const choice = await ctx.ui.select(`Jev suggests ${decision.tier}\n${detail}`, options_);
    if (!choice || choice.startsWith("Keep")) {
      appendDecisionEntry(analysis, decision, "skipped", runtime);
      return { action: "skipped", message: "kept current model" };
    }
    if (choice.startsWith(`Use ${cheaper}`)) {
      const cheaperModel = findModel(runtime.models, cheaperTarget);
      if (cheaperModel) {
        decision.model = cheaperModel;
        decision.target = cheaperTarget;
        decision.tier = cheaper;
        decision.tierIndex = tierIndex(cheaper);
      }
    }
  }

  const model =
    decision.model && typeof ctx.modelRegistry?.find === "function"
      ? ctx.modelRegistry.find(decision.model.provider, decision.model.id)
      : undefined;
  if (!model) {
    appendDecisionEntry(analysis, decision, "skipped", runtime);
    return { action: "skipped", message: `${headline} — model not available in this build` };
  }

  const previous = currentModelKey(ctx);
  const ok = await switchModel(model);
  if (!ok) {
    appendDecisionEntry(analysis, decision, "skipped", runtime);
    return { action: "skipped", message: `${headline} — no auth configured for provider` };
  }

  if (previous && previous !== `${model.provider}/${model.id}`) runtime.previousModelKey = previous;
  if (decision.target.thinkingLevel) {
    setThinking(decision.target.thinkingLevel);
  }

  runtime.appliedTierIndex = decision.tierIndex;
  runtime.lastDecision = decision;
  runtime.lastAnalysis = analysis;
  statusLine(ctx, runtime);
  notify(ctx, `${headline}\n${detail}`, "info");
  appendDecisionEntry(analysis, decision, guard?.rerouted ? "rerouted" : "switched", runtime);
  return { action: guard?.rerouted ? "rerouted" : "switched", message: `${headline}` };
}

// The ExtensionAPI instance for the running session, captured at load time.
// Only used for session-level model/thinking changes.
let api: ExtensionAPI | undefined;

async function switchModel(model: unknown): Promise<boolean> {
  if (!api || typeof api.setModel !== "function") return false;
  try {
    return await api.setModel(model as never);
  } catch {
    return false;
  }
}

function setThinking(level: string): void {
  if (!api || typeof api.setThinkingLevel !== "function") return;
  try {
    api.setThinkingLevel(level as never);
  } catch {
    // Clamping is model-specific; ignore unsupported levels.
  }
}

function formatAnalysis(analysis: RouteAnalysis): string {
  const probs = Object.entries(analysis.kindProbabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, p]) => `${kind} ${(p * 100).toFixed(0)}%`)
    .join(", ");
  return [
    `kind: ${analysis.kind} (confidence ${analysis.kindConfidence.toFixed(2)})`,
    `      ${probs}`,
    `complexity: ${analysis.complexity.toFixed(2)}/3 (conf ${analysis.complexityConfidence.toFixed(2)})`,
    `capability deserved: ${analysis.budgetIntensity.toFixed(2)}/3 (conf ${analysis.budgetIntensityConfidence.toFixed(2)})`,
    `deep reasoning: ${(analysis.deepReasoning * 100).toFixed(0)}%`,
    `jev latency: ${analysis.latencyMs}ms`,
  ].join("\n");
}

export default async function jevRouterExtension(pi: ExtensionAPI): Promise<void> {
  api = pi;

  const runtime: Runtime = {
    config: loadConfig(),
    ledger: loadLedger(loadConfig().stateFile),
    models: [],
  };

  // Not every pi build/fork exposes the full ExtensionAPI surface. Detect the
  // optional capabilities once so their absence degrades instead of failing install.
  const hasCommands = typeof pi.registerCommand === "function";
  const hasTools = typeof pi.registerTool === "function";

  // Optional: durable, TUI-only record of each routing decision (never sent to the LLM).
  // `registerEntryRenderer` and the pi-tui components are not available in every pi
  // build or fork, so feature-detect them and never let rendering break extension load.
  if (typeof pi.registerEntryRenderer === "function") {
    try {
      const { Box, Text } = await import("@earendil-works/pi-tui");
      pi.registerEntryRenderer<DecisionEntry>("jev-router-decision", (entry, { expanded }, theme) => {
        const data = entry.data;
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        if (!data) {
          box.addChild(new Text(theme.fg("dim", "jev-router: no decision data"), 0, 0));
          return box;
        }
        const glyph =
          data.action === "switched" ? "→" : data.action === "kept" ? "=" : data.action === "notified" ? "•" : "×";
        const label = data.skipReason ? `${theme.fg("accent", "jev-router ·")} ${theme.bold("not routed")}` : `${theme.fg("accent", `jev-router ${glyph} ${data.tier}`)}  ${theme.bold(data.model)}`;
        box.addChild(new Text(label, 0, 0));
        if (data.skipReason) {
          box.addChild(new Text(theme.fg("dim", `${data.reason}`), 0, 0));
          box.addChild(new Text(theme.fg("dim", `using ${data.model}`), 0, 0));
          return box;
        }
        box.addChild(new Text(theme.fg("dim", data.reason), 0, 0));
        if (data.notes.length > 0) {
          box.addChild(new Text(theme.fg("dim", data.notes.map((note) => `· ${note}`).join("\n")), 0, 0));
        }
        if (expanded) {
          box.addChild(
            new Text(
              theme.fg(
                "dim",
                `kind ${data.kind} (conf ${data.kindConfidence.toFixed(2)}) · ` +
                  `complexity ${data.complexity.toFixed(2)}/3 · capability ${data.capability.toFixed(2)}/3 · ` +
                  `deep reasoning ${(data.deepReasoning * 100).toFixed(0)}% · demand ${data.demand.toFixed(2)}` +
                  (data.pressure > 0 ? ` · budget ${(data.pressure * 100).toFixed(0)}% of cap` : ""),
              ),
              0,
              0,
            ),
          );
        }
        return box;
      });
    } catch {
      // TUI rendering unavailable in this build: decisions are still reported
      // through the status bar and notify, and persist as session entries.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    runtime.config = loadConfig(ctx.cwd);
    runtime.ledger = loadLedger(runtime.config.stateFile);
    runtime.models = toAvailable(ctx);
    runtime.appliedTierIndex = tierForModel(currentModelKey(ctx), runtime.config);
    statusLine(ctx, runtime);
    if (runtime.config.enabled && !hasApiKey(runtime.config)) {
      notify(ctx, 
        `pi-jev-model-router: no API key. Set ${runtime.config.apiKeyEnv} or add "apiKey" to ~/.pi/agent/pi-jev-model-router.json.`,
        "warning",
      );
    }
    if (runtime.config.enabled && !runtime.config.useDefaultModels) {
      const emptyTiers = TIERS.filter((tier) => tier !== "xpremium" && runtime.config.routes[tier].length === 0);
      if (emptyTiers.length > 0) {
        notify(
          ctx,
          `pi-jev-model-router: useDefaultModels is off and no models are configured for: ${emptyTiers.join(", ")}. Routing will skip those tiers.`,
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    saveLedger(runtime.config.stateFile, runtime.ledger);
  });

  pi.on("model_select", async (_event, ctx) => {
    runtime.models = toAvailable(ctx);
    runtime.appliedTierIndex = tierForModel(currentModelKey(ctx), runtime.config);
    statusLine(ctx, runtime);
  });

  // Spend accounting: every assistant message carries its computed cost.
  pi.on("message_end", async (event) => {
    const message = event.message as {
      role?: string;
      provider?: string;
      model?: string;
      usage?: { cost?: { total?: number } };
    };
    if (message.role !== "assistant") return;
    const cost = message.usage?.cost?.total;
    const key = message.provider && message.model ? `${message.provider}/${message.model}` : "unknown";
    if (typeof cost === "number" && cost > 0) {
      recordCost(runtime.ledger, key, cost);
      saveLedger(runtime.config.stateFile, runtime.ledger);
    }
  });

  // The routing hook: classify the prompt with Jev, then switch models in place.
  pi.on("input", async (event, ctx) => {
    if (!runtime.config.enabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.images?.length && !event.text?.trim()) return { action: "continue" };

    const text = event.text ?? "";
    const hasHistory = (historyExcerpt(ctx, 1)?.length ?? 0) > 0;
    const skip = shouldSkip(text, runtime.config, hasHistory);
    if (skip) {
      appendSkipEntry(skip, ctx, runtime);
      return { action: "continue" };
    }

    runtime.lastPrompt = text.trim();
    setStatus(ctx, "jev-router:…");
    try {
      const result = await analyse(text, ctx, runtime);
      if ("error" in result) {
        statusLine(ctx, runtime);
        notify(ctx, `jev-router: ${result.error}`, "warning");
        return { action: "continue" };
      }
      const { analysis, decision } = result;
      runtime.lastAnalysis = analysis;
      if (!decision) {
        appendSkipEntry("no route available", ctx, runtime);
        statusLine(ctx, runtime);
        return { action: "continue" };
      }
      await applyDecision(analysis, decision, ctx, runtime);
    } catch (error) {
      statusLine(ctx, runtime);
      const message = error instanceof JevError ? error.message : error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) notify(ctx, `jev-router: ${message}`, "warning");
    }
    return { action: "continue" };
  });

  if (hasCommands) pi.registerCommand("jev-router", {
    description: "TypeSafe Jev model router: status, on/off, mode, budget, suggest [--write]",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch ((sub ?? "status").toLowerCase()) {
        case "on":
          runtime.config.enabled = true;
          statusLine(ctx, runtime);
          notify(ctx, "jev-router enabled", "info");
          return;
        case "off":
          runtime.config.enabled = false;
          statusLine(ctx, runtime);
          notify(ctx, "jev-router disabled", "info");
          return;
        case "mode": {
          const mode = (rest[0] ?? "").toLowerCase();
          if (mode !== "auto" && mode !== "confirm" && mode !== "notify") {
            notify(ctx, "usage: /jev-router mode auto|confirm|notify", "warning");
            return;
          }
          runtime.config.mode = mode;
          statusLine(ctx, runtime);
          notify(ctx, `jev-router mode: ${mode}`, "info");
          return;
        }
        case "budget": {
          const [, amountRaw] = rest;
          const amount = Number.parseFloat(amountRaw ?? "");
          if (!Number.isFinite(amount) || amount <= 0) {
            notify(ctx, "usage: /jev-router budget daily|monthly <usd>", "warning");
            return;
          }
          if (rest[0] === "daily") runtime.config.budget.dailyUsd = amount;
          else if (rest[0] === "monthly") runtime.config.budget.monthlyUsd = amount;
          else {
            notify(ctx, "usage: /jev-router budget daily|monthly <usd>", "warning");
            return;
          }
          statusLine(ctx, runtime);
          notify(ctx, `budget ${rest[0]} cap: ${formatUsd(amount)} (session only — persist in pi-jev-model-router.json)`, "info");
          return;
        }
        case "revert": {
          if (!runtime.previousModelKey) {
            notify(ctx, "no previous model recorded", "warning");
            return;
          }
          const [provider, ...idParts] = runtime.previousModelKey.split("/");
          const model =
            typeof ctx.modelRegistry?.find === "function"
              ? ctx.modelRegistry.find(provider, idParts.join("/"))
              : undefined;
          if (!model) {
            notify(ctx, `previous model not found: ${runtime.previousModelKey}`, "warning");
            return;
          }
          await switchModel(model);
          notify(ctx, `reverted to ${runtime.previousModelKey}`, "info");
          return;
        }
        case "why": {
          if (!runtime.lastPrompt) {
            notify(ctx, "no routed prompt yet in this session", "warning");
            return;
          }
          const result = await analyse(runtime.lastPrompt, ctx, runtime);
          if ("error" in result) {
            notify(ctx, result.error, "warning");
            return;
          }
          const { analysis, decision } = result;
          notify(ctx, 
            [
              formatAnalysis(analysis),
              "",
              decision ? describeDecision(decision) : "no route available",
              decision?.notes.length ? decision.notes.join("\n") : "",
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          return;
        }
        case "suggest": {
          const loaded = loadScores(runtime.config.ranking.scoresFile);
          if (!loaded.ok) {
            notify(ctx, `jev-router suggest: ${loaded.error}`, "warning");
            return;
          }
          runtime.models = toAvailable(ctx);
          const { routes, kindModels, unmatched } = suggestRoutes(runtime.config, runtime.models, loaded.scores);
          const json = JSON.stringify({ routes, kindModels }, null, 2);
          const write = rest.includes("--write");
          const file = configPaths().generated;
          if (write) {
            if (Object.keys(routes).length === 0 && Object.keys(kindModels).length === 0) {
              notify(ctx, "jev-router suggest: nothing to write, none of the scored models are in pi's catalogue", "warning");
              return;
            }
            const tmp = `${file}.${randomUUID()}.tmp`;
            try {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(tmp, `${json}\n`);
              renameSync(tmp, file);
            } catch (error) {
              notify(ctx, `jev-router suggest: can't write ${file}: ${error instanceof Error ? error.message : String(error)}`, "warning");
              return;
            } finally {
              try {
                rmSync(tmp, { force: true });
              } catch {}
            }
            runtime.config = loadConfig(ctx.cwd);
            statusLine(ctx, runtime);
          }
          notify(
            ctx,
            [
              `suggested ${Object.keys(routes).length} tier(s) and ${Object.keys(kindModels).length} kind specialist(s) from ${Object.keys(loaded.scores.models).length - unmatched.length} scored model(s)`,
              unmatched.length > 0 ? `not in pi's catalogue: ${unmatched.join(", ")}` : "",
              write
                ? `wrote ${file} and applied it (hand-edited config still wins per tier/kind)`
                : "preview only: run /jev-router suggest --write to save and apply it",
              json,
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          return;
        }
        case "status":
        default: {
          const spend = spendSnapshot(runtime.ledger, runtime.config.budget);
          const lines = [
            `enabled: ${runtime.config.enabled}`,
            `mode: ${runtime.config.mode}`,
            `jev model: ${runtime.config.jevModel}`,
            `api key: ${hasApiKey(runtime.config) ? `${runtime.config.apiKeyEnv} ✓` : "missing"}`,
            `current model: ${currentModelKey(ctx) ?? "unknown"}`,
            `spend today: ${formatUsd(spend.today)}${spend.dailyCap ? ` / ${formatUsd(spend.dailyCap)}` : ""}`,
            `spend month: ${formatUsd(spend.month)}${spend.monthlyCap ? ` / ${formatUsd(spend.monthlyCap)}` : ""}`,
            `budget pressure: ${spend.pressure > 0 ? `${(spend.pressure * 100).toFixed(0)}%` : "no caps set"}`,
            `cache-aware: ${runtime.config.cache.aware ? `on (cap ${formatUsd(runtime.config.cache.maxPenaltyUsd)}, deadband ${runtime.config.cache.deadband})` : "off"}`,
            `built-in models: ${runtime.config.useDefaultModels ? "on" : "off (config-only)"}`,
            `jev requests: ${runtime.ledger.jev.requests}`,
            "",
            "routes:",
            ...TIERS.map((tier) => {
              const route = runtime.config.routes[tier];
              if (route.length === 0) return tier === "xpremium" ? `    ${tier.padEnd(9)} (off)` : `  ✗ ${tier.padEnd(9)} (none configured)`;
              const pick = firstAvailable(runtime.models, route);
              const marker = pick ? "✓" : "✗";
              const label = pick ? `${pick.model.provider}/${pick.model.id}` : `${route[0]?.provider}/${route[0]?.model}`;
              const alts = route.length > 1 ? ` (+${route.length - 1} fallback${route.length > 2 ? "s" : ""})` : "";
              return `  ${marker} ${tier.padEnd(9)} ${label}${alts}`;
            }),
            "",
            `kind specialists (${Object.keys(runtime.config.kindModels).length}):`,
            ...Object.entries(runtime.config.kindModels).map(([kind, chain]) => {
              const ok = firstAvailable(runtime.models, chain) !== undefined;
              return `  ${ok ? "✓" : "✗"} ${kind.padEnd(10)} ${describeKindRoutes(runtime.config, runtime.models, kind)}`;
            }),
            runtime.config.free.enabled
              ? `  free pool (${runtime.config.free.policy}, ${runtime.config.free.pool.length} configured) is tried ${runtime.config.free.policy === "prefer" ? "before these" : "after every tier"}`
              : "  free pool: off",
            "",
            runtime.lastDecision ? `last: ${describeDecision(runtime.lastDecision)}` : "last: none",
            "",
            "commands: /jev-router on|off|mode|budget|why|revert|suggest [--write] · /jev-route <text>",
          ];
          notify(ctx, lines.join("\n"), "info");
          return;
        }
      }
    },
  });

  if (hasCommands) pi.registerCommand("jev-route", {
    description: "Ask Jev which model tier a request deserves (no switching)",
    handler: async (args, ctx) => {
      const text = args.trim() || runtime.lastPrompt || "";
      if (!text) {
        notify(ctx, "usage: /jev-route <text>", "warning");
        return;
      }
      const result = await analyse(text, ctx, runtime);
      if ("error" in result) {
        notify(ctx, result.error, "warning");
        return;
      }
      const { analysis, decision } = result;
      notify(ctx, 
        [formatAnalysis(analysis), "", decision ? describeDecision(decision) : "no route available"].join("\n"),
        "info",
      );
    },
  });

  if (hasTools) pi.registerTool({
    name: "jev_route",
    label: "Jev Route",
    description:
      "Ask TypeSafe Jev what kind of work a request is and which model tier it deserves. Returns typed judgments (task kind, complexity, capability deserved, deep-reasoning need) plus a recommended model from the configured tiers. Use when deciding how much model to spend on a subtask.",
    promptSnippet: "Classify a request with TypeSafe Jev and get a recommended model tier",
    parameters: Type.Object({
      request: Type.String({ description: "The request or task text to classify" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await analyse(params.request, ctx, runtime);
      if ("error" in result) {
        return { content: [{ type: "text", text: `jev_route error: ${result.error}` }], details: undefined, isError: true };
      }
      const { analysis, decision } = result;
      const text = [
        formatAnalysis(analysis),
        "",
        decision ? describeDecision(decision) : "no route available",
        decision?.notes.length ? `notes: ${decision.notes.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { analysis, decision },
      };
    },
  });
}