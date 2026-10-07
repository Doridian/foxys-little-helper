// Formats transcript JSONL entries as readable text (used by transcript-cli and ask).

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatTranscript(lines: any[], count: number, full = false): string {
  const out: string[] = [];
  const log = (s: string) => out.push(s);
  const clip = (s: string, n: number) => (full || s.length <= n ? s : `${s.slice(0, n)}… (${s.length} chars)`);
  const starts = lines.flatMap((e, i) => (e.kind === "request" ? [i] : []));
  const from = starts.length > count ? starts[starts.length - count]! : 0;
  for (const e of lines.slice(from)) {
    const time = e.time.slice(11, 19);
    switch (e.kind) {
      case "request":
        log(`\n── ${time} ${e.player} ${"─".repeat(50)}\n> ${e.text}`);
        break;
      case "message":
        for (const b of (typeof e.message.content === "string" ? [{ type: "text", text: e.message.content }] : e.message.content) as Block[]) {
          if (b.type === "text" && e.message.role === "assistant") log(`  FLH: ${b.text}`);
          else if (b.type === "tool_use") log(`  → ${b.name} ${JSON.stringify(b.input)}`);
          else if (b.type === "compaction") log(`  (compacted: ${clip(String(b.content ?? "no summary"), 400)})`);
          else if (b.type === "tool_result") {
            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            log(`    ${b.is_error ? "✗" : "←"} ${clip(text, 400)}`);
          }
        }
        break;
      case "usage": {
        // A compaction's tokens are reported per iteration, not at the top level.
        const u = (e.compaction && e.usage.iterations?.find((i: { type: string }) => i.type === "compaction")) || e.usage;
        const cleared = (e.context_management?.applied_edits ?? []).map((a: { cleared_input_tokens?: number; cleared_tool_uses?: number }) => `; cleared ${a.cleared_tool_uses} tool uses / ${a.cleared_input_tokens} tokens`);
        const dropped = e.input_transformations ? `; THINKING TRANSFORMED ${JSON.stringify(e.input_transformations)}` : "";
        log(`    [${e.compaction ? "compaction" : e.stop_reason}; in ${u.input_tokens}, cache read ${u.cache_read_input_tokens ?? 0}, write ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens}${cleared.join("")}${dropped}]`);
        break;
      }
      case "error":
        log(`  ERROR: ${e.error}`);
        break;
      case "cancel":
        log(`  (cancelled by ${e.player})`);
        break;
    }
  }
  return out.join("\n");
}
