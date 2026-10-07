import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChunkSummary } from "@flh/protocol";
import { type Block, BlockIds, type ClusterOptions, DEFAULT_CLUSTER, clusterSurface } from "./cluster.ts";
import { chunk, chunkMap, rect, testInfo } from "./fixtures.ts";
import { chunkKey } from "./mirror.ts";

function cluster(chunks: ChunkSummary[], opts: ClusterOptions = DEFAULT_CLUSTER, ids = new BlockIds()): Block[] {
  return clusterSurface(chunks[0]!.surface, chunkMap(chunks), testInfo, ids, opts);
}
const recipesOf = (b: Block) => [...b.crafters.keys(), ...b.miners.keys()].sort();
const sortedRecipes = (blocks: Block[]) => blocks.map(recipesOf).sort((a, b) => a.join().localeCompare(b.join()));

describe("clustering", () => {
  it("counts lab statuses and machines without a recipe", () => {
    const [block] = cluster([
      { ...chunk("nauvis", 0, 0, { labs: 10 }), lab_statuses: { working: 4, missing_science_packs: 6 } },
      { ...chunk("nauvis", 1, 0, {}), idle_crafters: { "assembling-machine-2": 5 } },
    ]);
    assert.equal(block!.machines, 15);
    assert.equal(block!.problems, 6);
    assert.equal(block!.statuses.get("missing_science_packs"), 6);
    assert.equal(block!.statuses.get("no_recipe"), 5);
    assert.equal(block!.idleCrafters, 5);
  });

  it("joins touching chunks, including diagonally, regardless of recipe", () => {
    const blocks = cluster([
      chunk("nauvis", 0, 0, { crafters: { "copper-cable": 4 } }),
      chunk("nauvis", 1, 0, { crafters: { "electronic-circuit": 6 } }),
      chunk("nauvis", 2, 1, { crafters: { "iron-gear-wheel": 2 } }),
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.machines, 12);
    assert.deepEqual(blocks[0]!.bounds, { x1: 0, y1: 0, x2: 2, y2: 1 });
  });

  it("bridges a one-chunk gap only between related chunks", () => {
    const blocks = cluster([
      chunk("nauvis", 0, 0, { crafters: { "iron-plate": 10 } }),
      chunk("nauvis", 2, 0, { crafters: { "iron-plate": 10 } }), // gap, same recipe: same block
      chunk("nauvis", 4, 0, { crafters: { "plastic-bar": 3 } }), // gap, unrelated: separate
      chunk("nauvis", 10, 0, { crafters: { "iron-plate": 1 } }), // far away: separate
    ]);
    assert.deepEqual(sortedRecipes(blocks), [["iron-plate"], ["iron-plate"], ["plastic-bar"]]);
    assert.equal(blocks.find((b) => b.chunks.length === 2)!.machines, 20);
  });

  it("splits a large touching district into blocks by shared recipes and absorbs small fragments", () => {
    // Two 4x4 "city blocks" side by side, touching: circuits on the left, smelting on the right,
    // plus a single gear chunk inside the circuit block.
    const chunks = [
      ...rect("nauvis", 0, 0, 3, 3, { crafters: { "electronic-circuit": 4, "copper-cable": 6 } }),
      ...rect("nauvis", 4, 0, 7, 3, { crafters: { "iron-plate": 16 } }),
    ];
    chunks[5] = chunk("nauvis", chunks[5]!.x, chunks[5]!.y, { crafters: { "iron-gear-wheel": 2 } });
    const opts = { splitAbove: 16, minFragment: 3 };
    const blocks = cluster(chunks, opts);
    assert.deepEqual(sortedRecipes(blocks), [["copper-cable", "electronic-circuit", "iron-gear-wheel"], ["iron-plate"]]);

    // Below the split threshold the district stays one block.
    assert.equal(cluster(chunks, { ...opts, splitAbove: 64 }).length, 1);
  });

  it("keeps surfaces apart and gives surface-scoped ids", () => {
    const ids = new BlockIds();
    const a = cluster([chunk("nauvis", 0, 0, { labs: 10 })], DEFAULT_CLUSTER, ids);
    const b = cluster([chunk("gleba", 0, 0, { crafters: { "agricultural-science-pack": 8 } })], DEFAULT_CLUSTER, ids);
    assert.equal(a[0]!.id, "nauvis#1");
    assert.equal(b[0]!.id, "gleba#1");
  });

  it("keeps ids stable as blocks grow and new ones appear", () => {
    const ids = new BlockIds();
    const base = [chunk("nauvis", 0, 0, { crafters: { "iron-plate": 4 } }), chunk("nauvis", 20, 20, { miners: { "iron-ore": 8 } })];
    const first = cluster(base, DEFAULT_CLUSTER, ids);
    const idOf = (blocks: Block[], x: number, y: number) => blocks.find((b) => b.chunks.includes(chunkKey(x, y)))!.id;
    const smelter = idOf(first, 0, 0);
    const mine = idOf(first, 20, 20);

    const second = cluster([...base, chunk("nauvis", 1, 0, { crafters: { "iron-plate": 4 } }), chunk("nauvis", -30, 0, { labs: 2 })], DEFAULT_CLUSTER, ids);
    assert.equal(idOf(second, 1, 0), smelter);
    assert.equal(idOf(second, 20, 20), mine);
    assert.ok(![smelter, mine].includes(idOf(second, -30, 0)));
  });

  it("aggregates machines, products, statuses and attaches nearby stations", () => {
    const [block, ...rest] = cluster([
      chunk("nauvis", 0, 0, { crafters: { "electronic-circuit": [10, { working: 7, item_ingredient_shortage: 3 }] } }),
      chunk("nauvis", 1, 0, { crafters: { "copper-cable": [15, { working: 10, full_output: 5 }] }, entities: { roboport: 1, beacon: 4 } }),
      chunk("nauvis", 3, 0, { entities: { "train-stop": 1, "straight-rail": 30 }, stops: ["Circuits drop"] }),
      chunk("nauvis", 9, 9, { entities: { "train-stop": 1 }, stops: ["Lonely"] }),
    ]);
    assert.equal(rest.length, 0);
    assert.equal(block!.machines, 25);
    assert.equal(block!.working, 17);
    assert.equal(block!.problems, 3, "full_output is backed up, not a problem");
    assert.deepEqual(Object.fromEntries(block!.statuses), { item_ingredient_shortage: 3, full_output: 5 });
    assert.deepEqual([...block!.products].sort(), ["copper-cable", "electronic-circuit"]);
    assert.deepEqual(block!.trainStops, ["Circuits drop"]);
    assert.equal(block!.roboports, 1);
    assert.equal(block!.entities.get("beacon"), 4);
  });

  it("does not count status for chunks summarised while not visible", () => {
    const [block] = cluster([{ ...chunk("nauvis", 0, 0, { crafters: { "iron-plate": 4 }, visible: false }), crafters: [{ recipe: "iron-plate", machine: "stone-furnace", count: 4 }] }]);
    assert.equal(block!.machines, 4);
    assert.equal(block!.observed, 0);
  });
});
