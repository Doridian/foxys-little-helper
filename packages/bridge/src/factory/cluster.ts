// Groups indexed chunks into production blocks: areas of related production that a player would
// call one thing ("the blue circuit build", "the iron mine north of spawn").
//
// Production chunks are those with crafters, miners or labs. Clustering per surface:
// 1. Loose pass: union chunks that touch (8-neighbourhood), or are one chunk apart and share a
//    recipe/resource (a smelter column with a rail crossing it stays one block).
// 2. Components larger than `splitAbove` chunks are a megabase district or a big spaghetti base
//    where everything touches. Re-cluster them strictly: only touching chunks that share a
//    recipe/resource link, which separates neighbouring city blocks making different things (and
//    stops common intermediates like copper cable from chaining blocks across rails). Fragments smaller
//    than `minFragment` chunks (a lone gear assembler) are merged into the neighbour they touch most.
// 3. Chunks without production that hold train stops or roboports are attached to the nearest
//    block within two chunks, so stations at a block's edge show up with it.

import type { ChunkSummary } from "@flh/protocol";
import { chunkKey, keyX, keyY } from "./mirror.ts";

export interface ClusterOptions {
  splitAbove: number;
  minFragment: number;
}
export const DEFAULT_CLUSTER: ClusterOptions = { splitAbove: 64, minFragment: 3 };

/** Recipe/resource -> items, from prototype data. Unknown names fall back to the name itself. */
export interface RecipeInfo {
  products(recipe: string): string[];
  ingredients(recipe: string): string[];
  mined(resource: string): string[];
}

/** Statuses that mean a machine is doing its job. */
const OK = new Set(["working", "normal"]);
/** Not producing, but not broken either: output backed up, or switched off on purpose. */
const BACKED_UP = new Set([
  "full_output",
  "waiting_for_space_in_destination",
  "disabled_by_control_behavior",
  "disabled_by_script",
  "turned_off_during_daytime",
  "marked_for_deconstruction",
]);
export const isProblem = (status: string) => !OK.has(status) && !BACKED_UP.has(status);
export const isOk = (status: string) => OK.has(status);

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MachineGroup {
  /** Recipe or resource name. */
  name: string;
  count: number;
  machines: Map<string, number>;
  /** Machines whose status was recorded (chunk visible when summarised). */
  observed: number;
  statuses: Map<string, number>;
  /** Chunk bounds of where this recipe/resource is in the block. */
  bounds: Bounds;
}

export interface Block {
  id: string;
  surface: string;
  /** Production chunk keys (see chunkKey). */
  chunks: number[];
  /** Attached chunks (stations, roboports next to the block). */
  attached: number[];
  /** Chunk coordinate bounds of the production chunks, inclusive. */
  bounds: Bounds;
  crafters: Map<string, MachineGroup>;
  miners: Map<string, MachineGroup>;
  labs: number;
  /** Crafters + miners + labs. */
  machines: number;
  products: Set<string>;
  ingredients: Set<string>;
  trainStops: string[];
  roboports: number;
  /** Other entities in the production chunks by name. */
  entities: Map<string, number>;
  observed: number;
  working: number;
  /** Non-working statuses with counts. */
  statuses: Map<string, number>;
  /** Machines with a problem status (not working, not merely backed up). */
  problems: number;
  visibleChunks: number;
  tickMin: number;
  tickMax: number;
}

/** Recipes, resources and labs in a chunk: chunks sharing one are "related". */
function tags(c: ChunkSummary): string[] {
  const t: string[] = [];
  for (const x of c.crafters) t.push(x.recipe);
  for (const x of c.miners) t.push(`\0${x.resource}`);
  if (c.labs > 0) t.push("\0lab");
  return t;
}

const related = (a: string[], b: string[]) => a.some((t) => b.includes(t));
const isProduction = (c: ChunkSummary) => c.crafters.length > 0 || c.miners.length > 0 || c.labs > 0;
const hasNotable = (c: ChunkSummary) => (c.train_stops?.length ?? 0) > 0 || Object.keys(c.entities).some(isRoboport);
const isRoboport = (name: string) => name.includes("roboport");

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]!]!;
      i = p[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Groups of production chunk keys, plus attached chunk keys per group. */
export function clusterChunks(
  chunks: Map<number, ChunkSummary>,
  opts: ClusterOptions = DEFAULT_CLUSTER,
): { core: number[]; attached: number[] }[] {
  const keys: number[] = [];
  for (const [key, c] of chunks) if (isProduction(c)) keys.push(key);
  keys.sort((a, b) => a - b);
  const index = new Map<number, number>();
  keys.forEach((k, i) => index.set(k, i));
  const chunkTags = keys.map((k) => tags(chunks.get(k)!));

  // Neighbours within two chunks, by index, each pair once (j > i).
  const neighbours = (i: number, fn: (j: number, d: number) => void) => {
    const k = keys[i]!;
    const x = keyX(k);
    const y = keyY(k);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx === 0 && dy === 0) continue;
        const j = index.get(chunkKey(x + dx, y + dy));
        if (j !== undefined && j > i) fn(j, Math.max(Math.abs(dx), Math.abs(dy)));
      }
    }
  };

  const loose = new UnionFind(keys.length);
  for (let i = 0; i < keys.length; i++) {
    neighbours(i, (j, d) => {
      if (d === 1 || related(chunkTags[i]!, chunkTags[j]!)) loose.union(i, j);
    });
  }
  const components = groups(loose, keys.length);

  const result: number[][] = [];
  for (const members of components) {
    if (members.length <= opts.splitAbove) {
      result.push(members);
      continue;
    }
    // Strict pass within the component; `loose` links never cross components, so reuse `neighbours`.
    const strict = new UnionFind(keys.length);
    for (const i of members) {
      neighbours(i, (j, d) => {
        if (d === 1 && related(chunkTags[i]!, chunkTags[j]!)) strict.union(i, j);
      });
    }
    result.push(...absorbFragments(strict, members, neighbours, opts.minFragment));
  }

  // Attach station/roboport chunks to the closest block (distance 1 before 2).
  const groupOf = new Map<number, number>();
  result.forEach((members, g) => members.forEach((i) => groupOf.set(i, g)));
  const attached: number[][] = result.map(() => []);
  for (const [key, c] of chunks) {
    if (isProduction(c) || !hasNotable(c)) continue;
    const g = nearestGroup(keyX(key), keyY(key), index, groupOf);
    if (g !== undefined) attached[g]!.push(key);
  }
  return result.map((members, g) => ({ core: members.map((i) => keys[i]!), attached: attached[g]! }));
}

function groups(uf: UnionFind, n: number, only?: number[]): number[][] {
  const byRoot = new Map<number, number[]>();
  for (const i of only ?? Array.from({ length: n }, (_, i) => i)) {
    const r = uf.find(i);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = []));
    g.push(i);
  }
  return [...byRoot.values()];
}

function absorbFragments(
  uf: UnionFind,
  members: number[],
  neighbours: (i: number, fn: (j: number, d: number) => void) => void,
  minFragment: number,
): number[][] {
  // Repeat a few times: a fragment may only touch other fragments that grow in the same round.
  for (let round = 0; round < 3; round++) {
    const size = new Map<number, number>();
    for (const i of members) size.set(uf.find(i), (size.get(uf.find(i)) ?? 0) + 1);
    // root of small fragment -> (neighbour root -> touching pairs)
    const touch = new Map<number, Map<number, number>>();
    const count = (from: number, to: number) => {
      if (size.get(from)! >= minFragment) return;
      let t = touch.get(from);
      if (!t) touch.set(from, (t = new Map()));
      t.set(to, (t.get(to) ?? 0) + 1);
    };
    for (const i of members) {
      neighbours(i, (j, d) => {
        if (d !== 1) return;
        const a = uf.find(i);
        const b = uf.find(j);
        if (a === b) return;
        count(a, b);
        count(b, a);
      });
    }
    if (touch.size === 0) break;
    for (const [from, to] of touch) {
      let best: number | undefined;
      let bestScore = -1;
      for (const [root, n] of to) {
        // Prefer the neighbour touched most, then the bigger one.
        const score = n * 1e6 + size.get(root)!;
        if (score > bestScore) [best, bestScore] = [root, score];
      }
      if (best !== undefined) uf.union(from, best);
    }
  }
  return groups(uf, 0, members);
}

function nearestGroup(x: number, y: number, index: Map<number, number>, groupOf: Map<number, number>): number | undefined {
  for (let r = 1; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const i = index.get(chunkKey(x + dx, y + dy));
        if (i !== undefined) return groupOf.get(i);
      }
    }
  }
  return undefined;
}

const emptyBounds = (): Bounds => ({ x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
function grow(b: Bounds, x: number, y: number): void {
  if (x < b.x1) b.x1 = x;
  if (y < b.y1) b.y1 = y;
  if (x > b.x2) b.x2 = x;
  if (y > b.y2) b.y2 = y;
}
const inc = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/** Aggregate one cluster into a block (id assigned later). */
export function buildBlock(
  surface: string,
  group: { core: number[]; attached: number[] },
  chunks: Map<number, ChunkSummary>,
  info: RecipeInfo,
): Block {
  const block: Block = {
    id: "",
    surface,
    chunks: group.core,
    attached: group.attached,
    bounds: emptyBounds(),
    crafters: new Map(),
    miners: new Map(),
    labs: 0,
    machines: 0,
    products: new Set(),
    ingredients: new Set(),
    trainStops: [],
    roboports: 0,
    entities: new Map(),
    observed: 0,
    working: 0,
    statuses: new Map(),
    problems: 0,
    visibleChunks: 0,
    tickMin: Infinity,
    tickMax: -Infinity,
  };
  const add = (
    into: Map<string, MachineGroup>,
    name: string,
    machine: string,
    count: number,
    statuses: { [s: string]: number } | undefined,
    x: number,
    y: number,
  ) => {
    let g = into.get(name);
    if (!g) into.set(name, (g = { name, count: 0, machines: new Map(), observed: 0, statuses: new Map(), bounds: emptyBounds() }));
    g.count += count;
    inc(g.machines, machine, count);
    grow(g.bounds, x, y);
    block.machines += count;
    if (!statuses) return;
    for (const [s, n] of Object.entries(statuses)) {
      g.observed += n;
      inc(g.statuses, s, n);
      block.observed += n;
      if (isOk(s)) block.working += n;
      else {
        inc(block.statuses, s, n);
        if (isProblem(s)) block.problems += n;
      }
    }
  };

  for (const key of group.core) {
    const c = chunks.get(key)!;
    grow(block.bounds, c.x, c.y);
    if (c.visible) block.visibleChunks++;
    block.tickMin = Math.min(block.tickMin, c.tick);
    block.tickMax = Math.max(block.tickMax, c.tick);
    for (const x of c.crafters) add(block.crafters, x.recipe, x.machine, x.count, x.statuses, c.x, c.y);
    for (const x of c.miners) add(block.miners, x.resource, x.machine, x.count, x.statuses, c.x, c.y);
    block.labs += c.labs;
    block.machines += c.labs;
  }
  for (const key of [...group.core, ...group.attached]) {
    const c = chunks.get(key)!;
    if (c.train_stops) block.trainStops.push(...c.train_stops);
    for (const [name, n] of Object.entries(c.entities)) {
      if (isRoboport(name)) block.roboports += n;
      else inc(block.entities, name, n);
    }
  }
  block.trainStops = [...new Set(block.trainStops)].sort();

  for (const recipe of block.crafters.keys()) {
    for (const p of info.products(recipe)) block.products.add(p);
    for (const i of info.ingredients(recipe)) block.ingredients.add(i);
  }
  for (const resource of block.miners.keys()) for (const p of info.mined(resource)) block.products.add(p);
  return block;
}

/**
 * Keeps block ids stable across re-clustering: a new block inherits the id of the old block it
 * overlaps most (biggest blocks pick first); otherwise it gets a fresh `surface#n`.
 */
export class BlockIds {
  private readonly next = new Map<string, number>();
  private readonly byChunk = new Map<string, Map<number, string>>();

  assign(surface: string, blocks: Block[]): void {
    const previous = this.byChunk.get(surface) ?? new Map<number, string>();
    const taken = new Set<string>();
    const order = [...blocks].sort((a, b) => b.chunks.length - a.chunks.length || a.chunks[0]! - b.chunks[0]!);
    for (const block of order) {
      const overlap = new Map<string, number>();
      for (const k of block.chunks) {
        const id = previous.get(k);
        if (id !== undefined && !taken.has(id)) inc(overlap, id, 1);
      }
      let best: string | undefined;
      let bestN = 0;
      for (const [id, n] of overlap) if (n > bestN || (n === bestN && best !== undefined && id < best)) [best, bestN] = [id, n];
      if (!best) {
        const n = (this.next.get(surface) ?? 0) + 1;
        this.next.set(surface, n);
        best = `${surface}#${n}`;
      }
      taken.add(best);
      block.id = best;
    }
    const now = new Map<number, string>();
    for (const b of blocks) for (const k of b.chunks) now.set(k, b.id);
    this.byChunk.set(surface, now);
  }

  forget(surface: string): void {
    this.byChunk.delete(surface);
  }
}

export function clusterSurface(
  surface: string,
  chunks: Map<number, ChunkSummary>,
  info: RecipeInfo,
  ids: BlockIds,
  opts: ClusterOptions = DEFAULT_CLUSTER,
): Block[] {
  const blocks = clusterChunks(chunks, opts).map((g) => buildBlock(surface, g, chunks, info));
  ids.assign(surface, blocks);
  return blocks;
}
