// Parametric layout generators: deterministic code produces the geometry, the LLM only picks
// parameters. Coordinates are relative tile positions with y pointing down (south).

import type { BlueprintEntityData, ForceRecipeState, MachineData, RecipeData } from "@flh/protocol";
import type { PlannerData } from "./planner/solver.ts";

// Factorio 2.0 uses 16 directions; the cardinal ones are multiples of 4.
const NORTH = 0;
const EAST = 4;
const WEST = 12;

export interface GeneratedLayout {
  label: string;
  entities: BlueprintEntityData[];
  width: number;
  height: number;
  /** Human-readable notes on where to connect belts, lane usage, throughput. */
  notes: string[];
  crafts_per_min: number;
}

export interface AssemblerRowOptions {
  recipe: string;
  count: number;
  machine?: string;
  inserter?: string;
  belt?: string;
  pole?: string;
}

function firstAvailable(data: PlannerData, force: ForceRecipeState, candidates: string[]): string {
  const enabled = new Set(force.enabled_recipes);
  return candidates.find((name) => enabled.has(name)) ?? candidates[candidates.length - 1]!;
}

function pickMachine(data: PlannerData, force: ForceRecipeState, recipe: RecipeData): MachineData {
  const enabled = new Set(force.enabled_recipes);
  const categories = [recipe.category, ...(recipe.additional_categories ?? [])];
  const machines = [...data.machines.values()]
    .filter((m) => m.type !== "mining-drill" && (m.crafting_categories ?? []).some((c) => categories.includes(c)))
    .filter((m) => m.items_to_place.some((item) => enabled.has(item)))
    .filter((m) => !m.surface_conditions) // a generic row should work anywhere
    .filter((m) => m.size.width === 3 && m.size.height === 3);
  machines.sort((a, b) => b.speed - a.speed);
  if (!machines[0]) throw new Error(`No researched 3x3 machine without surface restrictions can craft '${recipe.name}'`);
  return machines[0];
}

/**
 * A row of 3x3 machines between two belts:
 *
 *   y=0  input belt, flowing east (feed it from the west end)
 *   y=1  pole, input inserter       (per machine)
 *   y=2-4  machine
 *   y=5  pole, output inserter
 *   y=6  output belt, flowing west (take output from the west end)
 *
 * Up to two solid ingredients, one per belt lane. No fluids.
 */
export function assemblerRow(data: PlannerData, force: ForceRecipeState, options: AssemblerRowOptions): GeneratedLayout {
  const recipe = data.recipes.get(options.recipe);
  if (!recipe) throw new Error(`Unknown recipe '${options.recipe}'`);
  if (recipe.ingredients.some((i) => i.type === "fluid") || recipe.products.some((p) => p.type === "fluid")) {
    throw new Error(`'${recipe.name}' uses fluids; the assembler_row layout only handles solid items`);
  }
  if (recipe.ingredients.length > 2) {
    throw new Error(`'${recipe.name}' has ${recipe.ingredients.length} ingredients; assembler_row supports at most 2 (one per belt lane)`);
  }
  const count = Math.max(1, Math.min(40, Math.round(options.count)));
  const machine = options.machine ? data.machines.get(options.machine) : pickMachine(data, force, recipe);
  if (!machine) throw new Error(`Unknown machine '${options.machine}'`);
  if (machine.size.width !== 3 || machine.size.height !== 3) {
    throw new Error(`assembler_row needs a 3x3 machine; ${machine.name} is ${machine.size.width}x${machine.size.height}`);
  }
  const inserter = options.inserter ?? firstAvailable(data, force, ["fast-inserter", "inserter"]);
  const belt = options.belt ?? firstAvailable(data, force, ["fast-transport-belt", "transport-belt"]);
  const pole = options.pole ?? firstAvailable(data, force, ["medium-electric-pole", "small-electric-pole"]);
  const setsRecipe = machine.type === "assembling-machine";

  const entities: BlueprintEntityData[] = [];
  const add = (name: string, x: number, y: number, extra: Partial<BlueprintEntityData> = {}) =>
    entities.push({ entity_number: entities.length + 1, name, position: { x, y }, ...extra });

  for (let i = 0; i < count; i++) {
    const x0 = i * 3;
    add(machine.name, x0 + 1.5, 3.5, setsRecipe ? { recipe: recipe.name } : {});
    add(inserter, x0 + 1.5, 1.5, { direction: NORTH }); // picks from the belt to the north
    add(inserter, x0 + 1.5, 5.5, { direction: NORTH }); // picks from the machine to the north
    add(pole, x0 + 0.5, 1.5);
    add(pole, x0 + 0.5, 5.5);
  }
  for (let x = 0; x < count * 3; x++) {
    add(belt, x + 0.5, 0.5, { direction: EAST });
    add(belt, x + 0.5, 6.5, { direction: WEST });
  }

  const craftTime = recipe.energy / machine.speed;
  const craftsPerMin = (count * 60) / craftTime;
  const lanes = recipe.ingredients.map((ing, lane) => `${ing.name} on the ${lane === 0 ? "left" : "right"} lane`);
  const notes = [
    `Input belt along the top row flows east; feed it from the west end (${lanes.join(", ")}; inserters take from both lanes, so the split only matters for balance).`,
    `Output belt along the bottom row flows west; ${recipe.products.map((p) => p.name).join(", ")} leaves at the west end.`,
    `Max ${Math.round(craftsPerMin * 10) / 10} crafts/min; needs per minute: ${recipe.ingredients.map((i) => `${Math.round(i.amount * craftsPerMin)} ${i.name}`).join(", ")}.`,
    `Connect a ${pole} to your power network near the row.`,
  ];
  if (machine.type === "furnace") notes.push("Furnaces pick their recipe from the input; electric furnaces avoid fuel.");
  return { label: `${count}x ${recipe.name} row`, entities, width: count * 3, height: 7, notes, crafts_per_min: craftsPerMin };
}
