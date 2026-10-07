// Rough performance check on a synthetic megabase index (~100k chunks). Timings are reported as
// test diagnostics; the limits are generous so slow CI machines don't flake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChunkSummary } from "@flh/protocol";
import { BlockIds, clusterSurface } from "./cluster.ts";
import { chunk, testInfo } from "./fixtures.ts";
import { IndexMirror, chunkKey } from "./mirror.ts";
import { describeBlock, overview, searchBlocks } from "./search.ts";

const THEMES = [
  { "iron-plate": 24 },
  { "copper-plate": 24 },
  { "copper-cable": 6, "electronic-circuit": 4 },
  { "advanced-circuit": 4, "copper-cable": 4 },
  { "processing-unit": 3 },
  { "iron-gear-wheel": 2, "automation-science-pack": 6 },
  { "plastic-bar": 6 },
];

/**
 * City blocks of 6x6 production chunks with a rail chunk between them; every other column of
 * city blocks touches its neighbour (no rails), making 12x6-chunk districts that need splitting.
 */
function megabase(size: number): Map<number, ChunkSummary> {
  const chunks = new Map<number, ChunkSummary>();
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const cellX = Math.floor(x / 7);
      const cellY = Math.floor(y / 7);
      const rail = y % 7 === 6 || (x % 7 === 6 && cellX % 2 === 1);
      const theme = THEMES[(cellX * 31 + cellY * 17) % THEMES.length]!;
      const crafters: { [recipe: string]: number | [number, { [s: string]: number }] } = {};
      for (const [recipe, n] of Object.entries(theme)) crafters[recipe] = (x + y) % 13 === 0 ? [n, { working: n - 2, item_ingredient_shortage: 2 }] : n;
      const c = rail
        ? chunk("nauvis", x, y, { entities: { "straight-rail": 40 }, ...(x % 7 === 3 ? { stops: [`Stop ${cellX}/${cellY}`], entities: { "train-stop": 1 } } : {}) })
        : chunk("nauvis", x, y, { crafters, entities: { "transport-belt": 60, beacon: 8, "fast-inserter": 30 } });
      chunks.set(chunkKey(x, y), c);
    }
  }
  return chunks;
}

describe("performance", () => {
  it("clusters and searches a 100k-chunk index quickly", (t) => {
    const all = [...megabase(317).values()];
    // Initial sync: 500-chunk pages into the mirror.
    let start = performance.now();
    const mirror = new IndexMirror();
    for (let i = 0; i < all.length; i += 500) mirror.apply({ revision: i + 500, chunks: all.slice(i, i + 500), removed: [], more: true });
    const mirrorMs = performance.now() - start;
    const chunks = mirror.surfaces.get("nauvis")!;

    start = performance.now();
    const blocks = clusterSurface("nauvis", chunks, testInfo, new BlockIds());
    const clusterMs = performance.now() - start;

    start = performance.now();
    const queries = [
      { item: "processing-unit" },
      { item: "blue circuit" },
      { text: "iron smelting" },
      { problems_only: true },
      { text: "Stop 12/20" },
      { near: { x: 5000, y: 5000 } },
      { recipe: "copper-cable", near: { x: 100, y: 100 } },
    ];
    const rounds = 20;
    for (let i = 0; i < rounds; i++) for (const q of queries) searchBlocks(blocks, q, testInfo.products);
    const searchMs = (performance.now() - start) / (rounds * queries.length);

    start = performance.now();
    overview(blocks);
    describeBlock(blocks[0]!, chunks);
    const overviewMs = performance.now() - start;

    const largest = Math.max(...blocks.map((b) => b.chunks.length));
    t.diagnostic(`${chunks.size} chunks -> ${blocks.length} blocks (largest ${largest} chunks); mirror sync ${mirrorMs.toFixed(0)} ms, cluster ${clusterMs.toFixed(0)} ms, search ${searchMs.toFixed(1)} ms/query, overview+describe ${overviewMs.toFixed(1)} ms`);
    assert.ok(chunks.size >= 100_000);
    // Touching districts got split back into roughly city blocks (6x6 plus a shared border).
    assert.ok(largest <= 48, "megabase districts are split into blocks");
    assert.ok(clusterMs < 10_000);
    assert.ok(searchMs < 200);
  });
});
