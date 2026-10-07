import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ForceRecipeState, MachineData, PrototypeData, RecipeData } from "@flh/protocol";
import { PlannerData, plan } from "./solver.ts";

function recipe(name: string, energy: number, ingredients: [string, number][], products: [string, number][], category = "crafting"): RecipeData {
  return {
    name,
    category,
    subgroup: "intermediate-product",
    energy,
    ingredients: ingredients.map(([n, amount]) => ({ type: "item", name: n, amount })),
    products: products.map(([n, amount]) => ({ type: "item", name: n, amount, probability: 1 })),
    hidden: false,
    maximum_productivity: 3,
  };
}

function machine(name: string, type: MachineData["type"], categories: string[], speed: number, extra: Partial<MachineData> = {}): MachineData {
  return {
    name,
    type,
    ...(type === "mining-drill" ? { resource_categories: categories } : { crafting_categories: categories }),
    speed,
    module_slots: 2,
    uses_module_effects: true,
    uses_beacon_effects: true,
    energy_usage_kw: 150,
    items_to_place: [name],
    size: { width: 3, height: 3 },
    ...extra,
  };
}

const data: PrototypeData = {
  recipes: [
    recipe("iron-plate", 3.2, [["iron-ore", 1]], [["iron-plate", 1]], "smelting"),
    recipe("copper-plate", 3.2, [["copper-ore", 1]], [["copper-plate", 1]], "smelting"),
    recipe("copper-cable", 0.5, [["copper-plate", 1]], [["copper-cable", 2]]),
    recipe("electronic-circuit", 0.5, [["iron-plate", 1], ["copper-cable", 3]], [["electronic-circuit", 1]], "electronics"),
    recipe("stone-furnace", 0.5, [["stone", 5]], [["stone-furnace", 1]]),
    recipe("electric-furnace", 5, [["steel-plate", 10]], [["electric-furnace", 1]]),
    recipe("assembling-machine-2", 0.5, [["iron-plate", 9]], [["assembling-machine-2", 1]]),
    recipe("electric-mining-drill", 2, [["iron-plate", 10]], [["electric-mining-drill", 1]]),
    recipe("widget", 1, [["gadget", 1]], [["widget", 1]]),
    recipe("gadget", 1, [["widget", 1], ["iron-plate", 1]], [["gadget", 2]]),
    recipe("metallic-asteroid-crushing", 2, [["metallic-asteroid-chunk", 1]], [["iron-ore", 20]], "crushing"),
    recipe("steam-condensation", 1, [["steam", 1000]], [["water", 90]], "chemistry"),
    recipe("ice-cube", 1, [["water", 10]], [["ice-cube", 1]]),
    recipe("molten-iron", 32, [["iron-ore", 50]], [["molten-iron", 500]], "metallurgy"),
    recipe("molten-iron-from-lava", 16, [["lava", 500]], [["molten-iron", 250]], "metallurgy"),
    recipe("casting-iron", 3.2, [["molten-iron", 20]], [["iron-plate", 2]], "metallurgy"),
  ],
  machines: [
    machine("stone-furnace", "furnace", ["smelting"], 1, { energy_usage_kw: 90, module_slots: 0 }),
    machine("electric-furnace", "furnace", ["smelting"], 2),
    machine("assembling-machine-2", "assembling-machine", ["crafting", "electronics"], 0.75),
    machine("electric-mining-drill", "mining-drill", ["basic-solid"], 0.5),
    machine("crusher", "assembling-machine", ["crushing"], 1, { surface_conditions: [{ property: "gravity", min: 0, max: 0 }] }),
    machine("foundry", "assembling-machine", ["metallurgy"], 4),
  ],
  beacons: [],
  modules: [{ name: "productivity-module", category: "productivity", effects: { productivity: 0.1, speed: -0.05, consumption: 0.4 } }],
  tile_fluids: ["water", "lava"],
  spoilage: [{ item: "iron-bacteria", result: "iron-ore", seconds: 60 }],
  resources: [
    { name: "iron-ore", category: "basic-solid", mining_time: 1, products: [{ type: "item", name: "iron-ore", amount: 1, probability: 1 }], infinite: false },
    { name: "copper-ore", category: "basic-solid", mining_time: 1, products: [{ type: "item", name: "copper-ore", amount: 1, probability: 1 }], infinite: false },
  ],
};

const force: ForceRecipeState = {
  enabled_recipes: data.recipes.map((r) => r.name).filter((n) => n !== "electric-furnace"),
  recipe_productivity: {},
  mining_productivity: 0,
};

const planner = new PlannerData(data);
const close = (actual: number | undefined, expected: number) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);
const step = (p: ReturnType<typeof plan>, recipeName: string) => p.steps.find((s) => s.recipe === recipeName)!;
const rate = (list: { name: string; rate: number }[], name: string) => list.find((x) => x.name === name)?.rate;

describe("planner", () => {
  it("plans green circuits with researched machines", () => {
    const p = plan(planner, force, { item: "electronic-circuit", rate: 100 });
    close(step(p, "electronic-circuit").machines, (100 * 0.5) / (60 * 0.75));
    close(step(p, "copper-cable").machines, (150 * 0.5) / (60 * 0.75));
    assert.equal(step(p, "copper-plate").machine, "stone-furnace", "electric furnace is not researched");
    close(step(p, "copper-plate").machines, (150 * 3.2) / 60);
    close(step(p, "iron-plate").machines, (100 * 3.2) / 60);
    close(rate(p.raw_inputs, "iron-ore"), 100);
    close(rate(p.raw_inputs, "copper-ore"), 150);
    close(p.mining.find((m) => m.item === "copper-ore")?.drills, 150 / 30);
    assert.deepEqual(p.warnings, []);
  });

  it("applies productivity modules and research bonus", () => {
    const p = plan(
      planner,
      { ...force, recipe_productivity: { "electronic-circuit": 0.1 } },
      { item: "electronic-circuit", rate: 100, modules: [{ machine: "assembling-machine-2", modules: ["productivity-module", "productivity-module"] }] },
    );
    const s = step(p, "electronic-circuit");
    close(s.productivity, 0.3);
    close(s.speed, 0.75 * 0.9);
    close(s.crafts_per_min, 100 / 1.3);
    close(rate(p.raw_inputs, "iron-ore"), 100 / 1.3);
  });

  it("stops at externally supplied inputs", () => {
    const p = plan(planner, force, { item: "electronic-circuit", rate: 100, inputs: ["iron-plate", "copper-plate"] });
    assert.deepEqual(p.steps.map((s) => s.recipe).sort(), ["copper-cable", "electronic-circuit"]);
    close(rate(p.raw_inputs, "copper-plate"), 150);
    assert.deepEqual(p.mining, []);
  });

  it("prefers the best researched machine", () => {
    const p = plan(planner, { ...force, enabled_recipes: [...force.enabled_recipes, "electric-furnace"] }, { item: "iron-plate", rate: 60 });
    assert.equal(step(p, "iron-plate").machine, "electric-furnace");
    assert.deepEqual(p.warnings, []);
  });

  it("honours machine overrides and surface conditions", () => {
    const p = plan(planner, force, { item: "iron-plate", rate: 60, machines: { smelting: "electric-furnace" } });
    close(step(p, "iron-plate").machines, (60 * 3.2) / (60 * 2));

    const conditional: PrototypeData = {
      ...data,
      machines: data.machines.map((m) => (m.name === "stone-furnace" ? { ...m, surface_conditions: [{ property: "pressure", min: 1000, max: 1000 }] } : m)),
    };
    const q = plan(new PlannerData(conditional), force, { item: "iron-plate", rate: 60, surface: { properties: { pressure: 0 }, resources: ["iron-ore"], tile_fluids: [] } });
    assert.equal(step(q, "iron-plate").machine, "electric-furnace");
  });

  it("treats mined and pumped resources as raw unless overridden", () => {
    const crushing = { ...force, enabled_recipes: [...force.enabled_recipes, "metallic-asteroid-crushing", "steam-condensation"] };
    const p = plan(planner, crushing, { item: "iron-plate", rate: 60 });
    assert.deepEqual(p.steps.map((s) => s.recipe), ["iron-plate"]);
    close(rate(p.raw_inputs, "iron-ore"), 60);

    const q = plan(planner, crushing, { item: "ice-cube", rate: 60 });
    close(rate(q.raw_inputs, "water"), 600);
    assert.equal(q.mining[0]?.resource, "offshore-pump");

    const r = plan(planner, crushing, { item: "iron-plate", rate: 60, recipes: { "iron-ore": "metallic-asteroid-crushing" } });
    assert.ok(r.steps.some((s) => s.recipe === "metallic-asteroid-crushing"));
  });

  it("only mines what exists on the target surface", () => {
    const crushing = { ...force, enabled_recipes: [...force.enabled_recipes, "metallic-asteroid-crushing"] };
    const platform = { properties: {}, resources: [], tile_fluids: [] };
    const p = plan(planner, crushing, { item: "iron-plate", rate: 60, surface: platform });
    assert.ok(p.steps.some((s) => s.recipe === "metallic-asteroid-crushing"));
    close(rate(p.raw_inputs, "metallic-asteroid-chunk"), 3);

    const q = plan(planner, force, { item: "copper-plate", rate: 60, surface: { properties: {}, resources: ["iron-ore"], tile_fluids: [] } });
    assert.ok(q.warnings.some((w) => w.includes("copper-ore") && w.includes("imported")));
    close(rate(q.raw_inputs, "copper-ore"), 60);
    assert.deepEqual(q.mining, []);
  });

  it("picks recipes that work with what the surface has", () => {
    const vulcanus = { properties: { gravity: 40 }, resources: [], tile_fluids: ["lava"] };
    const p = plan(planner, force, { item: "molten-iron", rate: 600, surface: vulcanus });
    assert.deepEqual(p.steps.map((s) => s.recipe), ["molten-iron-from-lava"]);
    close(rate(p.raw_inputs, "lava"), 1200);

    const gleba = { properties: { gravity: 20 }, resources: [], tile_fluids: ["water"] };
    const q = plan(planner, force, { item: "iron-plate", rate: 60, surface: gleba, machines: { smelting: "stone-furnace" } });
    assert.ok(q.warnings.some((w) => w.includes("iron-bacteria")), q.warnings.join("; "));
  });

  it("credits byproducts and merges multi-output recipes", () => {
    const recycling: PrototypeData = {
      ...data,
      recipes: [
        ...data.recipes,
        {
          ...recipe("scrap-recycling", 0.2, [["scrap", 1]], [], "recycling-or-hand-crafting"),
          products: [
            { type: "item", name: "holmium-ore", amount: 1, probability: 0.01 },
            { type: "item", name: "stone", amount: 1, probability: 0.04 },
          ],
        },
        recipe("holmium-thing", 1, [["holmium-ore", 1], ["stone", 1]], [["holmium-thing", 1]]),
      ],
      machines: [...data.machines, machine("recycler", "furnace", ["recycling-or-hand-crafting"], 0.5)],
      resources: [...data.resources, { name: "scrap", category: "basic-solid", mining_time: 1, products: [{ type: "item", name: "scrap", amount: 1, probability: 1 }], infinite: false }],
    };
    const f = { ...force, enabled_recipes: [...force.enabled_recipes, "scrap-recycling", "holmium-thing"] };
    const p = plan(new PlannerData(recycling), f, { item: "holmium-thing", rate: 6 });
    // Holmium is the bottleneck: 6/min at 1% = 600 crafts; the 24 stone/min that come with it cover the 6 needed.
    assert.equal(p.steps.filter((s) => s.recipe === "scrap-recycling").length, 1);
    close(step(p, "scrap-recycling").crafts_per_min, 600);
    close(rate(p.raw_inputs, "scrap"), 600);
    close(rate(p.byproducts, "stone"), 18);
  });

  it("falls back to the most basic machine when none is researched", () => {
    const p = plan(planner, { ...force, enabled_recipes: ["iron-plate"] }, { item: "iron-plate", rate: 60 });
    assert.equal(step(p, "iron-plate").machine, "stone-furnace");
    assert.ok(p.warnings.some((w) => w.includes("No researched machine")));
  });

  it("cuts recipe loops and reports them", () => {
    const p = plan(planner, force, { item: "widget", rate: 60 });
    assert.ok(p.warnings.some((w) => w.includes("Recipe loop")));
    close(rate(p.raw_inputs, "widget"), 30);
  });
});
