// Turns production blocks into compact, LLM-facing answers: ranked search, an overview and the
// detail for one block. Pure functions over Block lists.

import type { Area, ChunkSummary } from "@flh/protocol";
import { type Block, type Bounds, type MachineGroup, isProblem } from "./cluster.ts";
import { keyX, keyY } from "./mirror.ts";

/**
 * A named place (e.g. "main bus", "gleba science") another part of the bridge knows about.
 * Blocks overlapping a place that matches the search text rank higher.
 */
export interface PlaceMatch {
  name: string;
  surface: string;
  area: Area;
}
export type PlaceSearch = (text: string) => PlaceMatch[] | Promise<PlaceMatch[]>;

export interface SearchQuery {
  surface?: string;
  item?: string;
  recipe?: string;
  text?: string;
  near?: { x: number; y: number };
  problems_only?: boolean;
  limit?: number;
}

/** What players call things -> prototype names. Matched as whole phrases in `text` and `item`. */
const ALIASES: [string, string[]][] = [
  ["green circuit", ["electronic-circuit"]],
  ["green chip", ["electronic-circuit"]],
  ["red circuit", ["advanced-circuit"]],
  ["red chip", ["advanced-circuit"]],
  ["blue circuit", ["processing-unit"]],
  ["blue chip", ["processing-unit"]],
  ["red science", ["automation-science-pack"]],
  ["green science", ["logistic-science-pack"]],
  ["black science", ["military-science-pack"]],
  ["grey science", ["military-science-pack"]],
  ["gray science", ["military-science-pack"]],
  ["military science", ["military-science-pack"]],
  ["blue science", ["chemical-science-pack"]],
  ["purple science", ["production-science-pack"]],
  ["yellow science", ["utility-science-pack"]],
  ["white science", ["space-science-pack"]],
  ["space science", ["space-science-pack"]],
  ["gleba science", ["agricultural-science-pack"]],
  ["vulcanus science", ["metallurgic-science-pack"]],
  ["fulgora science", ["electromagnetic-science-pack"]],
  ["aquilo science", ["cryogenic-science-pack"]],
  ["promethium science", ["promethium-science-pack"]],
  ["science", ["automation-science-pack", "logistic-science-pack", "military-science-pack", "chemical-science-pack", "production-science-pack", "utility-science-pack", "space-science-pack", "agricultural-science-pack", "metallurgic-science-pack", "electromagnetic-science-pack", "cryogenic-science-pack", "promethium-science-pack"]],
  ["lds", ["low-density-structure"]],
  ["low density", ["low-density-structure"]],
  ["rcu", ["rocket-control-unit"]],
  ["oil", ["crude-oil", "petroleum-gas", "heavy-oil", "light-oil"]],
  ["gears", ["iron-gear-wheel"]],
  ["gear", ["iron-gear-wheel"]],
  ["cable", ["copper-cable"]],
  ["steel", ["steel-plate"]],
  ["iron", ["iron-plate", "iron-ore"]],
  ["copper", ["copper-plate", "copper-ore"]],
  ["smelting", ["iron-plate", "copper-plate", "steel-plate", "stone-brick"]],
];
const STOPWORDS = new Set(
  "a an and the of for to in on at is are we our my do does make makes made making where which what show me find build builds block area factory production line setup".split(" "),
);

const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
/** Crude singular, so "circuits" finds "electronic-circuit". */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Prototype names an item query or text stands for, plus the words left over. */
export function expandText(text: string): { items: Set<string>; words: string[] } {
  let rest = ` ${norm(text).split(" ").map(stem).join(" ")} `;
  const items = new Set<string>();
  // Longest phrases first so "blue science" wins over "science".
  for (const [phrase, names] of [...ALIASES].sort((a, b) => b[0].length - a[0].length)) {
    const p = ` ${phrase} `;
    if (!rest.includes(p)) continue;
    names.forEach((n) => items.add(n));
    rest = rest.replace(p, " ");
  }
  return { items, words: rest.split(" ").filter((w) => w !== "" && !STOPWORDS.has(w)) };
}

// ---- Formatting helpers ----

export const tileArea = (b: Bounds): Area => ({
  left_top: { x: b.x1 * 32, y: b.y1 * 32 },
  right_bottom: { x: (b.x2 + 1) * 32, y: (b.y2 + 1) * 32 },
});
const center = (b: Bounds) => ({ x: ((b.x1 + b.x2 + 1) * 32) / 2, y: ((b.y1 + b.y2 + 1) * 32) / 2 });
export const gps = (b: Bounds, surface: string) => {
  const c = center(b);
  return `[gps=${c.x},${c.y},${surface}]`;
};
const sorted = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]);
const pct = (n: number, d: number) => Math.round((100 * n) / d);

/** "88% working, 6 item_ingredient_shortage, 2 full_output" (or "no live status" when not visible). */
export function healthLine(b: { observed: number; working: number; statuses: Map<string, number> }): string {
  if (b.observed === 0) return "no live status (not visible)";
  const parts = [`${pct(b.working, b.observed)}% working`];
  for (const [s, n] of sorted(b.statuses).slice(0, 3)) parts.push(`${n} ${s}`);
  return parts.join(", ");
}

function groupLine(g: MachineGroup): string {
  return `${g.name} x${g.count}`;
}

export interface BlockSummary {
  id: string;
  surface: string;
  gps: string;
  size: string;
  machines: number;
  makes: string;
  health: string;
  stations?: string[];
  why?: string;
}

export function summarize(b: Block, why?: string): BlockSummary {
  const groups = [...b.crafters.values(), ...b.miners.values()].sort((x, y) => y.count - x.count);
  const makes = groups.slice(0, 4).map(groupLine);
  if (groups.length > 4) makes.push(`+${groups.length - 4} more`);
  if (b.labs > 0) makes.push(`labs x${b.labs}`);
  return {
    id: b.id,
    surface: b.surface,
    gps: gps(b.bounds, b.surface),
    size: `${(b.bounds.x2 - b.bounds.x1 + 1) * 32}x${(b.bounds.y2 - b.bounds.y1 + 1) * 32}`,
    machines: b.machines,
    makes: makes.join(", "),
    health: healthLine(b),
    ...(b.trainStops.length > 0 ? { stations: b.trainStops.slice(0, 5) } : {}),
    ...(why ? { why } : {}),
  };
}

// ---- Search ----

/** Distance in tiles from a point to a block's area (0 inside). */
function distance(b: Block, p: { x: number; y: number }): number {
  const a = tileArea(b.bounds);
  const dx = Math.max(a.left_top.x - p.x, 0, p.x - a.right_bottom.x);
  const dy = Math.max(a.left_top.y - p.y, 0, p.y - a.right_bottom.y);
  return Math.hypot(dx, dy);
}

const overlaps = (b: Block, a: Area) => {
  const t = tileArea(b.bounds);
  return t.left_top.x < a.right_bottom.x && a.left_top.x < t.right_bottom.x && t.left_top.y < a.right_bottom.y && a.left_top.y < t.right_bottom.y;
};

/** Machines in the block making any of the items. */
function makingCount(b: Block, items: Set<string>, products: (recipe: string) => string[]): number {
  let n = 0;
  for (const g of b.crafters.values()) if (products(g.name).some((p) => items.has(p))) n += g.count;
  return n;
}

export function searchBlocks(
  blocks: Block[],
  q: SearchQuery,
  products: (recipe: string) => string[],
  places: PlaceMatch[] = [],
): BlockSummary[] {
  const itemQuery = q.item ? expandItem(q.item) : undefined;
  const text = q.text ? expandText(q.text) : undefined;
  const recipe = q.recipe?.toLowerCase();
  const criteria = itemQuery !== undefined || text !== undefined || recipe !== undefined;
  const scored: { block: Block; score: number; why: string[] }[] = [];

  for (const b of blocks) {
    if (q.surface && b.surface !== q.surface) continue;
    if (q.problems_only && b.problems === 0) continue;
    let score = 0;
    const why: string[] = [];

    if (itemQuery) {
      const s = itemScore(b, itemQuery, products, why);
      if (s === 0) continue;
      score += s;
    }
    if (recipe) {
      let hit = false;
      for (const g of b.crafters.values()) {
        if (g.name === recipe) score += 100 + (50 * g.count) / b.machines;
        else if (g.name.includes(recipe)) score += 40;
        else continue;
        hit = true;
        why.push(`recipe ${g.name} x${g.count}`);
      }
      if (!hit) continue;
    }
    if (text) {
      const s = textScore(b, text, products, places, why);
      if (s === 0) continue;
      score += s;
    }
    if (q.problems_only) score += criteria ? b.problems / (b.problems + 10) : b.problems;
    if (!criteria && !q.problems_only) score += b.machines;
    if (q.near) {
      const d = distance(b, q.near);
      // Nearby blocks first when nothing else ranks; otherwise a tie-breaking bonus.
      score += criteria || q.problems_only ? 20 / (1 + d / 256) : 1e9 / (1 + d);
      why.push(`${Math.round(d)} tiles away`);
    }
    // Small bias towards bigger blocks so a dedicated build beats a stray machine.
    score += Math.log10(1 + b.machines);
    scored.push({ block: b, score, why });
  }

  scored.sort((a, b) => b.score - a.score || a.block.id.localeCompare(b.block.id));
  return scored.slice(0, q.limit ?? 10).map((s) => summarize(s.block, s.why.join("; ") || undefined));
}

function expandItem(item: string): Set<string> {
  const { items } = expandText(item);
  items.add(item.toLowerCase());
  return items;
}

function itemScore(b: Block, items: Set<string>, products: (recipe: string) => string[], why: string[]): number {
  let score = 0;
  const made = [...items].filter((i) => b.products.has(i));
  if (made.length > 0) {
    const n = makingCount(b, items, products);
    // Most of the block making it beats a block that makes it on the side.
    score += 100 + (50 * n) / Math.max(b.machines, 1);
    why.push(n > 0 ? `makes ${made.join(", ")} (${n} machines)` : `mines ${made.join(", ")}`);
  }
  const used = [...items].filter((i) => b.ingredients.has(i));
  if (used.length > 0) {
    score += 30;
    why.push(`uses ${used.join(", ")}`);
  }
  return score;
}

function textScore(
  b: Block,
  text: { items: Set<string>; words: string[] },
  products: (recipe: string) => string[],
  places: PlaceMatch[],
  why: string[],
): number {
  let score = text.items.size > 0 ? itemScore(b, text.items, products, why) : 0;
  const names = [...b.crafters.keys(), ...b.miners.keys(), ...b.products].map(norm);
  const stops = b.trainStops.map((s) => s.toLowerCase());
  const surface = norm(b.surface);
  for (const w of text.words) {
    if (stops.some((s) => s.includes(w))) {
      score += 25;
      why.push(`station ~${w}`);
    } else if (names.some((n) => n.includes(w))) {
      score += 20;
      why.push(`name ~${w}`);
    } else if (surface.includes(w)) {
      score += 15;
    }
  }
  for (const p of places) {
    if (p.surface === b.surface && overlaps(b, p.area)) {
      score += 60;
      why.push(`in ${p.name}`);
    }
  }
  return score;
}

// ---- Overview ----

export function overview(blocks: Block[], surfaceFilter?: string, top = 8) {
  const surfaces = new Map<string, Block[]>();
  for (const b of blocks) {
    if (surfaceFilter && b.surface !== surfaceFilter) continue;
    let list = surfaces.get(b.surface);
    if (!list) surfaces.set(b.surface, (list = []));
    list.push(b);
  }
  return [...surfaces].map(([surface, list]) => {
    const statuses = new Map<string, number>();
    let machines = 0;
    let observed = 0;
    let working = 0;
    for (const b of list) {
      machines += b.machines;
      observed += b.observed;
      working += b.working;
      for (const [s, n] of b.statuses) statuses.set(s, (statuses.get(s) ?? 0) + n);
    }
    const bySize = [...list].sort((a, b) => b.machines - a.machines);
    const troubled = list.filter((b) => b.problems > 0).sort((a, b) => b.problems - a.problems);
    return {
      surface,
      blocks: list.length,
      machines,
      health: healthLine({ observed, working, statuses }),
      top_blocks: bySize.slice(0, top).map((b) => summarize(b)),
      problem_blocks: troubled.slice(0, 5).map((b) => ({ id: b.id, gps: gps(b.bounds, b.surface), problems: b.problems, health: healthLine(b) })),
      ...(troubled.length > 5 ? { more_problem_blocks: troubled.length - 5 } : {}),
    };
  });
}

// ---- Block detail ----

const groupDetail = (g: MachineGroup, surface: string) => ({
  name: g.name,
  count: g.count,
  machines: Object.fromEntries(g.machines),
  ...(g.observed > 0 ? { statuses: Object.fromEntries(sorted(g.statuses)) } : {}),
  ...(g.observed < g.count ? { no_live_status: g.count - g.observed } : {}),
  area: tileArea(g.bounds),
  gps: gps(g.bounds, surface),
});

export function describeBlock(b: Block, chunks: Map<number, ChunkSummary>, maxSpots = 8, maxGroups = 15) {
  const inputs = [...b.ingredients].filter((i) => !b.products.has(i)).sort();
  const outputs = [...b.products].filter((p) => !b.ingredients.has(p)).sort();
  const recipes = [...b.crafters.values()].sort((x, y) => y.count - x.count);
  const mining = [...b.miners.values()].sort((x, y) => y.count - x.count);

  // Chunks with problem statuses, worst first, so the LLM can drill in with status_summary/find_entities.
  const spots: { key: number; problems: number; statuses: Map<string, number>; recipes: Set<string> }[] = [];
  for (const key of b.chunks) {
    const c = chunks.get(key);
    if (!c) continue;
    const statuses = new Map<string, number>();
    const recipes = new Set<string>();
    let problems = 0;
    for (const g of [...c.crafters.map((x) => ({ ...x, name: x.recipe })), ...c.miners.map((x) => ({ ...x, name: x.resource }))]) {
      for (const [s, n] of Object.entries(g.statuses ?? {})) {
        if (!isProblem(s)) continue;
        statuses.set(s, (statuses.get(s) ?? 0) + n);
        recipes.add(g.name);
        problems += n;
      }
    }
    if (problems > 0) spots.push({ key, problems, statuses, recipes });
  }
  spots.sort((a, b) => b.problems - a.problems || a.key - b.key);

  return {
    id: b.id,
    surface: b.surface,
    gps: gps(b.bounds, b.surface),
    area: tileArea(b.bounds),
    chunks: b.chunks.length,
    visible_chunks: b.visibleChunks,
    summarised_ticks: [b.tickMin, b.tickMax],
    machines: b.machines,
    health: healthLine(b),
    recipes: recipes.slice(0, maxGroups).map((g) => groupDetail(g, b.surface)),
    ...(recipes.length > maxGroups ? { more_recipes: recipes.slice(maxGroups).map(groupLine).join(", ") } : {}),
    ...(mining.length > 0 ? { mining: mining.slice(0, maxGroups).map((g) => groupDetail(g, b.surface)) } : {}),
    ...(b.labs > 0 ? { labs: b.labs } : {}),
    inputs,
    outputs,
    ...(b.trainStops.length > 0 ? { stations: b.trainStops } : {}),
    ...(b.roboports > 0 ? { roboports: b.roboports } : {}),
    other_entities: Object.fromEntries(sorted(b.entities).slice(0, 10)),
    problem_areas: spots.slice(0, maxSpots).map((s) => {
      const x = keyX(s.key);
      const y = keyY(s.key);
      const bounds = { x1: x, y1: y, x2: x, y2: y };
      return { area: tileArea(bounds), gps: gps(bounds, b.surface), problems: Object.fromEntries(sorted(s.statuses)), recipes: [...s.recipes] };
    }),
    ...(spots.length > maxSpots ? { more_problem_areas: spots.length - maxSpots } : {}),
  };
}
