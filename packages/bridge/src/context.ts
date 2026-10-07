// Keeps each player's conversation context small without ever editing it ourselves.
//
// The history is append-only on our side: Claude Opus 5.5 binds every thinking block to the exact
// conversation before it ("preserved thinking"), so trimming or rewriting earlier turns client-side
// invalidates that reasoning (and is a 400 on newer accounts). Instead we use the two server-side
// mechanisms, which the check does not count as edits:
//
// - Context editing (clear_tool_uses): inside one long investigation the API replaces old tool
//   results with a placeholder once the prompt gets large. Factory data goes stale quickly anyway.
//   Every clear changes the prompt from the first newly cleared result onwards, so the cache is
//   rewritten from there on each request while clearing is active; that's why the trigger is high
//   and this is the safety net for very long requests, not the main tool.
// - Compaction (on demand, via the tool runner): once a request is done and the conversation is
//   bigger than `compactAfter`, it is summarised into one compaction block, which replaces the
//   history (the SDK does the swap; the checked prefix restarts at that block). The next request
//   then starts small with a cacheable prefix. Players' requests are usually minutes apart, past
//   the 5 minute cache TTL, so a long history would mostly be paid for uncached anyway.
//   If a single request grows past `compactDuring` even after clearing, it is compacted mid-way.

import type { BetaContextManagementConfig, BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

/** Token thresholds; the env overrides exist so tests can exercise clearing and compaction on a small world. */
export const CONTEXT_LIMITS = {
  /** Start clearing old tool results when the prompt (before clearing) is this big. */
  clearTrigger: envNumber("FLH_CLEAR_TRIGGER_TOKENS", 100_000),
  /** Most recent tool uses that are never cleared. */
  clearKeep: envNumber("FLH_CLEAR_KEEP", 10),
  /** Skip a clear that would remove less than this: not worth rewriting the cache for. */
  clearAtLeast: envNumber("FLH_CLEAR_AT_LEAST_TOKENS", 30_000),
  /** After a request, compact when the conversation is bigger than this. */
  compactAfter: envNumber("FLH_COMPACT_AFTER_TOKENS", 50_000),
  /** Compact in the middle of a request when the prompt (after clearing) is bigger than this. */
  compactDuring: envNumber("FLH_COMPACT_DURING_TOKENS", 200_000),
};

export const CONTEXT_BETAS = [
  "context-management-2025-06-27",
  "compact-2026-09-04",
  // Record-only: responses list any thinking block whose conversation we changed (input_transformations),
  // so an accidental client-side edit shows up in the transcript instead of silently losing reasoning.
  "thinking-binding-controls-2026-08-01",
] as const;

/**
 * Results of these tools carry ids the conversation refers to later (proposal ids for
 * resolve_proposal, design ids for propose_build/give_blueprint), and they are small.
 */
const NEVER_CLEAR = ["propose_build", "generate_layout"];

export function contextManagement(): BetaContextManagementConfig {
  return {
    edits: [
      {
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: CONTEXT_LIMITS.clearTrigger },
        keep: { type: "tool_uses", value: CONTEXT_LIMITS.clearKeep },
        clear_at_least: { type: "input_tokens", value: CONTEXT_LIMITS.clearAtLeast },
        exclude_tools: NEVER_CLEAR,
      },
    ],
  };
}

/** Everything the model read for this response (after server-side clearing). */
export function promptTokens(message: BetaMessage): number {
  const u = message.usage;
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Whether to compact once the runner has finished with this response. */
export function shouldCompact(message: BetaMessage): boolean {
  const tokens = promptTokens(message) + message.usage.output_tokens;
  if (message.stop_reason === "tool_use") return tokens > CONTEXT_LIMITS.compactDuring;
  return tokens > CONTEXT_LIMITS.compactAfter;
}

export function isCompaction(message: BetaMessage): boolean {
  return message.content.some((block) => block.type === "compaction");
}

/**
 * Replaces the default summarisation prompt, so it has to ask for everything worth keeping. Live
 * numbers go stale, so they matter less than decisions, names and open threads.
 */
export const COMPACTION_INSTRUCTIONS = `Summarise this conversation between Foxie's Little Helper (an in-game Factorio assistant) and the players, so the helper can continue it without the earlier messages. Write it as notes for the helper, not for the players.

Keep:
- What each player asked for, what was answered or done, and anything still open or promised (including a question the helper asked and is waiting on).
- Pending proposals (ids, labels, surface, position) and whether each was approved, rejected or turned into a blueprint; design ids that may be referred to again; actions taken that might be undone.
- Names players gave to places or builds, and where they are (surface, [gps] position or area).
- Findings: root causes found, which machines or areas were affected (with positions), and what fix was suggested.
- Player preferences and constraints they stated.

Leave out raw tool output and exact live numbers (rates, inventories, statuses) unless a conclusion depends on them; the factory changes, so the helper should look again rather than trust old readings. Be concise.`;
