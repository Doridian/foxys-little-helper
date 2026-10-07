import { DEFAULT_BLUEPRINT_DIR } from "./designs.ts";
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
  blueprintDir: string;
  /** Let the helper search factorioprints.com (FLH_PUBLIC_BLUEPRINTS=0 turns it off). */
  publicBlueprints: boolean;
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
    effort: env("FLH_EFFORT", "medium") as Config["effort"],
    maxIterations: Number(env("FLH_MAX_ITERATIONS", "40")),
    transcriptDir: env("FLH_TRANSCRIPT_DIR", DEFAULT_TRANSCRIPT_DIR),
    blueprintDir: env("FLH_BLUEPRINT_DIR", DEFAULT_BLUEPRINT_DIR),
    publicBlueprints: env("FLH_PUBLIC_BLUEPRINTS", "1") !== "0",
  };
}
