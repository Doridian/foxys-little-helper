// Append-only JSONL log of every conversation turn: player messages, the model's messages
// (text and tool calls), tool results, usage and errors. One file per day.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BetaContextManagementResponse,
  BetaInputTransformation,
  BetaMessageParam,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const DEFAULT_TRANSCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dev/transcripts");

export type TranscriptEntry =
  | { kind: "request"; player: string; text: string }
  | { kind: "message"; player: string; message: BetaMessageParam }
  | {
      kind: "usage";
      player: string;
      usage: BetaUsage;
      stop_reason: string | null;
      /** Server-side tool-result clearing applied to this request. */
      context_management?: BetaContextManagementResponse;
      /** Thinking blocks the API dropped or flagged because earlier turns changed; should never appear. */
      input_transformations?: BetaInputTransformation[];
      /** This response was a compaction (summary of the conversation so far). */
      compaction?: boolean;
    }
  | { kind: "error"; player: string; error: string }
  | { kind: "cancel"; player: string };

export class Transcript {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  log(entry: TranscriptEntry): void {
    const now = new Date();
    const file = join(this.dir, `${now.toISOString().slice(0, 10)}.jsonl`);
    try {
      appendFileSync(file, JSON.stringify({ time: now.toISOString(), ...entry }) + "\n");
    } catch (err) {
      console.error("[transcript] write failed:", err);
    }
  }
}
