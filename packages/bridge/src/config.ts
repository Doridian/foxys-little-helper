import { DEFAULT_TRANSCRIPT_DIR } from "./transcript.ts";

export interface Config {
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  pollIntervalMs: number;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxIterations: number;
  transcriptDir: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    rconHost: env("FLH_RCON_HOST", "127.0.0.1"),
    rconPort: Number(env("FLH_RCON_PORT", "27015")),
    rconPassword: env("FLH_RCON_PASSWORD"),
    pollIntervalMs: Number(env("FLH_POLL_MS", "250")),
    model: env("FLH_MODEL", "claude-opus-5-5"),
    effort: env("FLH_EFFORT", "high") as Config["effort"],
    maxIterations: Number(env("FLH_MAX_ITERATIONS", "40")),
    transcriptDir: env("FLH_TRANSCRIPT_DIR", DEFAULT_TRANSCRIPT_DIR),
  };
}
