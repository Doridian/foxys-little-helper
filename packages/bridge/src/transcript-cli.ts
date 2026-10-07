// Pretty-prints conversation transcripts.
//   npm run transcript -w @flh/bridge             last 5 requests from today
//   npm run transcript -w @flh/bridge -- 20       last 20 requests
//   npm run transcript -w @flh/bridge -- 5 2026-10-07 --full   untruncated tool results
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TRANSCRIPT_DIR } from "./transcript.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const positional = args.filter((a) => !a.startsWith("--"));
const count = Number(positional.find((a) => /^\d+$/.test(a)) ?? 5);
const day = positional.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10);
const dir = process.env.FLH_TRANSCRIPT_DIR ?? DEFAULT_TRANSCRIPT_DIR;

const clip = (s: string, n: number) => (full || s.length <= n ? s : `${s.slice(0, n)}… (${s.length} chars)`);

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };

const lines = readFileSync(join(dir, `${day}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const starts = lines.flatMap((e, i) => (e.kind === "request" ? [i] : []));
const from = starts.length > count ? starts[starts.length - count]! : 0;

for (const e of lines.slice(from)) {
  const time = e.time.slice(11, 19);
  switch (e.kind) {
    case "request":
      console.log(`\n── ${time} ${e.player} ${"─".repeat(50)}\n> ${e.text}`);
      break;
    case "message":
      for (const b of (typeof e.message.content === "string" ? [{ type: "text", text: e.message.content }] : e.message.content) as Block[]) {
        if (b.type === "text" && e.message.role === "assistant") console.log(`  FLH: ${b.text}`);
        else if (b.type === "tool_use") console.log(`  → ${b.name} ${JSON.stringify(b.input)}`);
        else if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          console.log(`    ${b.is_error ? "✗" : "←"} ${clip(text, 400)}`);
        }
      }
      break;
    case "usage": {
      const u = e.usage;
      console.log(`    [${e.stop_reason}; in ${u.input_tokens}, cache read ${u.cache_read_input_tokens ?? 0}, write ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens}]`);
      break;
    }
    case "error":
      console.log(`  ERROR: ${e.error}`);
      break;
    case "cancel":
      console.log(`  (cancelled by ${e.player})`);
      break;
  }
}
