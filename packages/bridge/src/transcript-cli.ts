// Pretty-prints conversation transcripts.
//   npm run transcript -w @flh/bridge             last 5 requests from today
//   npm run transcript -w @flh/bridge -- 20       last 20 requests
//   npm run transcript -w @flh/bridge -- 5 2026-10-07 --full   untruncated tool results
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TRANSCRIPT_DIR } from "./transcript.ts";
import { formatTranscript } from "./transcript-format.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const positional = args.filter((a) => !a.startsWith("--"));
const count = Number(positional.find((a) => /^\d+$/.test(a)) ?? 5);
const day = positional.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10);
const dir = process.env.FLH_TRANSCRIPT_DIR ?? DEFAULT_TRANSCRIPT_DIR;

const lines = readFileSync(join(dir, `${day}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log(formatTranscript(lines, count, full));
