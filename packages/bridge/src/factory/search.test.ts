import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChunkSummary } from "@flh/protocol";
import { type Block, BlockIds, clusterSurface } from "./cluster.ts";
import { chunk, chunkMap, rect, testInfo } from "./fixtures.ts";
import { describeBlock, expandText, overview, searchBlocks } from "./search.ts";

// A small two-planet factory:
//   nauvis#1 blue circuit build (processing-unit + some advanced-circuit), 2x2 chunks at (0,0)
//   nauvis#2 green circuits, with a station, at (10,0); two chunks starved of plates
//   nauvis#3 iron smelting column at (0,10)
//   nauvis#4 a mixed mall at (-20,-20) with 2 processing-unit assemblers on the side
//   gleba#1  agricultural science at (0,0)
const surfaces: { [surface: string]: ChunkSummary[] } = {
  nauvis: [
    ...rect("nauvis", 0, 0, 1, 1, { crafters: { "processing-unit": 12, "advanced-circuit": 4 } }),
    chunk("nauvis", 10, 0, { crafters: { "electronic-circuit": [8, { item_ingredient_shortage: 8 }], "copper-cable": 12 } }),
    chunk("nauvis", 11, 0, { crafters: { "electronic-circuit": [8, { working: 2, item_ingredient_shortage: 6 }] } }),
    chunk("nauvis", 12, 0, { entities: { "train-stop": 1 }, stops: ["Green circuit pickup"] }),
    ...rect("nauvis", 0, 10, 0, 13, { crafters: { "iron-plate": 48 } }),
    chunk("nauvis", -20, -20, { crafters: { "iron-gear-wheel": 2, "processing-unit": 2, "plastic-bar": 3, "automation-science-pack": 5 } }),
  ],
  gleba: [chunk("gleba", 0, 0, { crafters: { "agricultural-science-pack": [6, { working: 4, no_power: 2 }] } })],
};
const ids = new BlockIds();
const chunks = new Map(Object.entries(surfaces).map(([s, list]) => [s, chunkMap(list)]));
const blocks: Block[] = [...chunks].flatMap(([s, map]) => clusterSurface(s, map, testInfo, ids));
const mall = blocks.find((b) => b.crafters.has("iron-gear-wheel"))!;
/** The dedicated block for a recipe (not the mall). */
const byRecipe = (recipe: string) => blocks.find((b) => b !== mall && b.crafters.has(recipe))!;
const search = (q: Parameters<typeof searchBlocks>[1], places?: Parameters<typeof searchBlocks>[3]) => searchBlocks(blocks, q, testInfo.products, places);

describe("expandText", () => {
  it("maps player names to prototypes and drops filler words", () => {
    const { items, words } = expandText("where do we make blue circuits?".replace("?", ""));
    assert.deepEqual({ items, words }, { items: new Set(["processing-unit"]), words: [] });
    assert.deepEqual([...expandText("the Gleba science build").items], ["agricultural-science-pack"]);
    assert.deepEqual(expandText("iron smelting").words, []);
  });
});

describe("searchBlocks", () => {
  it("ranks a dedicated build above a block that makes the item on the side, and users after makers", () => {
    const results = search({ item: "processing-unit" });
    assert.equal(results[0]!.id, byRecipe("processing-unit").id);
    assert.equal(results[1]!.id, mall.id);
    assert.equal(results.length, 2);
    assert.match(results[0]!.why!, /makes processing-unit \(48 machines\)/);

    const users = search({ item: "electronic-circuit" });
    assert.equal(users[0]!.id, byRecipe("electronic-circuit").id, "maker first");
    assert.match(users[1]!.why!, /uses electronic-circuit/);
  });

  it("understands common names in item and text", () => {
    assert.equal(search({ item: "blue circuit" })[0]!.id, byRecipe("processing-unit").id);
    assert.equal(search({ text: "Gleba science build" })[0]!.surface, "gleba");
  });

  it("matches station names and recipe words in text", () => {
    assert.equal(search({ text: "pickup" })[0]!.id, byRecipe("electronic-circuit").id);
    const smelting = search({ text: "plate" });
    assert.equal(smelting[0]!.id, byRecipe("iron-plate").id);
    // A full station name beats item matches.
    const station = search({ text: "where is green circuit pickup" })[0]!;
    assert.equal(station.id, byRecipe("electronic-circuit").id);
    assert.match(station.why!, /station Green circuit pickup/);
  });

  it("filters by recipe, surface and problems", () => {
    assert.deepEqual(search({ recipe: "iron-plate" }).map((r) => r.id), [byRecipe("iron-plate").id]);
    assert.deepEqual(search({ surface: "gleba" }).map((r) => r.surface), ["gleba"]);
    const broken = search({ problems_only: true });
    assert.deepEqual(broken.map((r) => r.id), [byRecipe("electronic-circuit").id, byRecipe("agricultural-science-pack").id]);
    assert.match(broken[0]!.health, /^50% working, 14 item_ingredient_shortage/);
  });

  it("ranks by distance with `near`, and boosts blocks inside a matching named place", () => {
    assert.equal(search({ surface: "nauvis", near: { x: -600, y: -600 } })[0]!.id, mall.id);
    const places = [{ name: "the mall", surface: "nauvis", area: { left_top: { x: -700, y: -700 }, right_bottom: { x: -600, y: -600 } } }];
    const results = search({ text: "mall" }, places);
    assert.equal(results[0]!.id, mall.id);
    assert.match(results[0]!.why!, /in the mall/);
  });

  it("returns compact summaries with gps links", () => {
    const [r] = search({ recipe: "processing-unit", limit: 1 });
    assert.deepEqual(r, {
      id: byRecipe("processing-unit").id,
      surface: "nauvis",
      gps: "[gps=32,32,nauvis]",
      size: "64x64",
      machines: 64,
      makes: "processing-unit x48, advanced-circuit x16",
      health: "100% working",
      why: "recipe processing-unit x48",
    });
  });
});

describe("overview and describeBlock", () => {
  it("rolls up surfaces and problem blocks", () => {
    const o = overview(blocks);
    const nauvis = o.find((s) => s.surface === "nauvis")!;
    assert.equal(nauvis.blocks, 4);
    assert.deepEqual(nauvis.top_blocks.map((b) => b.machines), [192, 64, 28, 12]);
    assert.deepEqual(nauvis.problem_blocks.map((b) => b.problems), [14]);
  });

  it("describes a block with inputs, outputs, stations and problem areas", () => {
    const b = byRecipe("electronic-circuit");
    const d = describeBlock(b, chunks.get("nauvis")!);
    assert.deepEqual(d.area, { left_top: { x: 320, y: 0 }, right_bottom: { x: 384, y: 32 } });
    assert.deepEqual(d.inputs, ["copper-plate", "iron-plate"]);
    assert.deepEqual(d.outputs, ["electronic-circuit"]);
    assert.deepEqual(d.stations, ["Green circuit pickup"]);
    assert.deepEqual(
      d.problem_areas.map((p) => [p.gps, p.problems]),
      [
        ["[gps=336,16,nauvis]", { item_ingredient_shortage: 8 }],
        ["[gps=368,16,nauvis]", { item_ingredient_shortage: 6 }],
      ],
    );
  });
});
