// Synthetic ChunkSummary builders for the factory index tests.

import type { ChunkSummary } from "@flh/protocol";
import type { RecipeInfo } from "./cluster.ts";
import { chunkKey } from "./mirror.ts";

export interface ChunkSpec {
  /** recipe -> count, or [count, statuses]. */
  crafters?: { [recipe: string]: number | [number, { [status: string]: number }] };
  miners?: { [resource: string]: number | [number, { [status: string]: number }] };
  labs?: number;
  entities?: { [name: string]: number };
  stops?: string[];
  revision?: number;
  visible?: boolean;
}

export function chunk(surface: string, x: number, y: number, spec: ChunkSpec = {}): ChunkSummary {
  const split = (v: number | [number, { [s: string]: number }]) => (typeof v === "number" ? { count: v, statuses: { working: v } } : { count: v[0], statuses: v[1] });
  return {
    surface,
    x,
    y,
    revision: spec.revision ?? 1,
    tick: 1000,
    visible: spec.visible ?? true,
    crafters: Object.entries(spec.crafters ?? {}).map(([recipe, v]) => ({ recipe, machine: "assembling-machine-3", ...split(v) })),
    miners: Object.entries(spec.miners ?? {}).map(([resource, v]) => ({ resource, machine: "electric-mining-drill", ...split(v) })),
    labs: spec.labs ?? 0,
    entities: spec.entities ?? { "transport-belt": 20 },
    ...(spec.stops ? { train_stops: spec.stops } : {}),
  };
}

export function chunkMap(chunks: ChunkSummary[]): Map<number, ChunkSummary> {
  return new Map(chunks.map((c) => [chunkKey(c.x, c.y), c]));
}

/** A rectangle of chunks with the same contents. */
export function rect(surface: string, x1: number, y1: number, x2: number, y2: number, spec: ChunkSpec): ChunkSummary[] {
  const out: ChunkSummary[] = [];
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) out.push(chunk(surface, x, y, spec));
  return out;
}

const RECIPES: { [recipe: string]: [string[], string[]] } = {
  "iron-plate": [["iron-ore"], ["iron-plate"]],
  "copper-plate": [["copper-ore"], ["copper-plate"]],
  "copper-cable": [["copper-plate"], ["copper-cable"]],
  "electronic-circuit": [["iron-plate", "copper-cable"], ["electronic-circuit"]],
  "advanced-circuit": [["electronic-circuit", "plastic-bar", "copper-cable"], ["advanced-circuit"]],
  "processing-unit": [["electronic-circuit", "advanced-circuit", "sulfuric-acid"], ["processing-unit"]],
  "iron-gear-wheel": [["iron-plate"], ["iron-gear-wheel"]],
  "automation-science-pack": [["copper-plate", "iron-gear-wheel"], ["automation-science-pack"]],
  "agricultural-science-pack": [["bioflux", "pentapod-egg"], ["agricultural-science-pack"]],
  "plastic-bar": [["petroleum-gas", "coal"], ["plastic-bar"]],
};

export const testInfo: RecipeInfo = {
  products: (r) => RECIPES[r]?.[1] ?? [r],
  ingredients: (r) => RECIPES[r]?.[0] ?? [],
  mined: (r) => [r],
};
