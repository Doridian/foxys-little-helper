// Production planner: given a target item and rate, picks recipes and machines and works out
// how many machines each step needs, plus raw inputs, byproducts and mining drills.
//
// Pure functions over prototype data, so it is deterministic and unit-testable. The LLM
// decides *what* to plan; this decides the numbers.
//
// Limitations (v1): byproducts are credited greedily in planning order rather than optimised
// (a full linear-programming solve would also balance e.g. oil cracking), recipe loops are cut
// and reported, spoilage is not modelled and quality is ignored.

import type {
  BeaconData,
  Effects,
  ForceRecipeState,
  MachineData,
  ModuleData,
  ProductData,
  PrototypeData,
  RecipeData,
  ResourceData,
  SurfaceConditionData,
  SurfaceInfoData,
} from "@flh/protocol";

export interface ModuleConfig {
  /** Machine prototype this applies to. */
  machine: string;
  modules?: string[];
  beacons?: { name: string; count: number; modules: string[] };
}

export interface PlanRequest {
  item: string;
  /** Items (or fluid units) per minute. */
  rate: number;
  /** Where this is built: properties for surface conditions, and which resources/fluids exist there. */
  surface?: SurfaceInfoData;
  /** item -> recipe to use for it. */
  recipes?: Record<string, string>;
  /** recipe or recipe category -> machine to use. */
  machines?: Record<string, string>;
  /** Items that are supplied externally (e.g. from the main bus); not expanded further. */
  inputs?: string[];
  modules?: ModuleConfig[];
  /** Plan with recipes and machines that have not been researched yet. */
  allowLocked?: boolean;
}

export interface PlanStep {
  recipe: string;
  machine: string;
  /** Fractional machine count; build ceil(machines). */
  machines: number;
  crafts_per_min: number;
  speed: number;
  productivity: number;
  power_kw: number;
  inputs: { name: string; rate: number }[];
  outputs: { name: string; rate: number }[];
}

export interface MiningStep {
  resource: string;
  item: string;
  rate: number;
  drill?: string;
  drills?: number;
  note?: string;
}

export interface Plan {
  item: string;
  rate: number;
  steps: PlanStep[];
  raw_inputs: { name: string; rate: number }[];
  byproducts: { name: string; rate: number }[];
  mining: MiningStep[];
  total_power_kw: number;
  warnings: string[];
}

export class PlannerData {
  readonly recipes = new Map<string, RecipeData>();
  readonly machines = new Map<string, MachineData>();
  readonly beacons = new Map<string, BeaconData>();
  readonly modules = new Map<string, ModuleData>();
  /** item -> recipes producing it (excluding recycling, barrelling, hidden). */
  readonly producers = new Map<string, RecipeData[]>();
  /** item -> recipes consuming it. */
  readonly consumers = new Map<string, RecipeData[]>();
  /** item -> resources that yield it when mined. */
  readonly mined = new Map<string, ResourceData[]>();
  /** Fluids pumped from tiles by offshore pumps. */
  readonly tileFluids: Set<string>;
  /** item -> items that spoil into it. */
  readonly spoilsFrom = new Map<string, { item: string; seconds: number }[]>();

  constructor(data: PrototypeData) {
    for (const r of data.recipes) {
      this.recipes.set(r.name, r);
      for (const i of r.ingredients) push(this.consumers, i.name, r);
      if (!isProductionRecipe(r)) continue;
      for (const p of r.products) {
        if (expectedAmount(p) > 0 && !r.ingredients.some((i) => i.name === p.name && i.amount >= expectedAmount(p))) {
          push(this.producers, p.name, r);
        }
      }
    }
    for (const m of data.machines) this.machines.set(m.name, m);
    for (const b of data.beacons) this.beacons.set(b.name, b);
    for (const m of data.modules) this.modules.set(m.name, m);
    for (const res of data.resources) for (const p of res.products) push(this.mined, p.name, res);
    this.tileFluids = new Set(data.tile_fluids);
    for (const s of data.spoilage) push(this.spoilsFrom, s.result, { item: s.item, seconds: s.seconds });
  }


}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Per-item recycling recipes are hidden, so `hidden` excludes them while keeping scrap recycling.
const EXCLUDED_SUBGROUPS = new Set(["fill-barrel", "empty-barrel"]);

function isProductionRecipe(r: RecipeData): boolean {
  return !r.hidden && !EXCLUDED_SUBGROUPS.has(r.subgroup);
}

export function expectedAmount(p: ProductData): number {
  const base = p.amount ?? ((p.amount_min ?? 0) + (p.amount_max ?? 0)) / 2;
  return p.probability * base + (p.extra_count_fraction ?? 0);
}

/** Output per craft including productivity. Productivity does not apply to ignored_by_productivity. */
function outputPerCraft(p: ProductData, productivity: number): number {
  const amount = expectedAmount(p);
  const affected = Math.max(0, amount - (p.ignored_by_productivity ?? 0));
  return amount + affected * productivity;
}

function meetsConditions(conditions: SurfaceConditionData[] | undefined, props: Record<string, number> | undefined): boolean {
  if (!conditions || !props) return true;
  return conditions.every((c) => {
    const value = props[c.property];
    return value === undefined || (value >= c.min && value <= c.max);
  });
}

function categoriesOf(r: RecipeData): string[] {
  return [r.category, ...(r.additional_categories ?? [])];
}

const EFFECT_NAMES = ["speed", "productivity", "consumption", "pollution", "quality"] as const;

function addEffects(into: Required<Effects>, add: Effects | undefined, scale: number, allowed: (e: string) => boolean) {
  if (!add) return;
  for (const name of EFFECT_NAMES) {
    const v = add[name];
    if (v !== undefined && allowed(name)) into[name] += v * scale;
  }
}

const EPSILON = 1e-9;

interface StepGroup {
  recipe: RecipeData;
  machine: MachineData;
  fx: Required<Effects>;
  productivity: number;
  speed: number;
  crafts: number;
}

class Solver {
  private readonly warnings: string[] = [];
  private readonly enabled: Set<string>;
  private readonly inputs: Set<string>;

  constructor(
    private readonly data: PlannerData,
    private readonly force: ForceRecipeState,
    private readonly req: PlanRequest,
  ) {
    this.enabled = new Set(force.enabled_recipes);
    this.inputs = new Set(req.inputs ?? []);
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** The resources and tile fluids that exist where we build (all of them if no surface was given). */
  private localResources(item: string): ResourceData[] {
    const all = this.data.mined.get(item) ?? [];
    const local = this.req.surface?.resources;
    return local ? all.filter((r) => local.includes(r.name)) : all;
  }

  private isLocalFluid(item: string): boolean {
    return this.data.tileFluids.has(item) && (this.req.surface?.tile_fluids.includes(item) ?? true);
  }

  /** Mined or pumped here: a raw input unless a recipe is explicitly requested. */
  private isLocalResource(item: string): boolean {
    return this.localResources(item).length > 0 || this.isLocalFluid(item);
  }

  /** Some machine can run this recipe on the target surface. */
  private canCraftHere(r: RecipeData): boolean {
    const props = this.req.surface?.properties;
    if (!meetsConditions(r.surface_conditions, props)) return false;
    const cats = categoriesOf(r);
    return [...this.data.machines.values()].some(
      (m) => (m.crafting_categories ?? []).some((c) => cats.includes(c)) && meetsConditions(m.surface_conditions, props),
    );
  }

  /** Shallow lookahead: supplied, mined/pumped here, made by a recipe that runs here, or spoils from such an item. */
  private obtainableHere(item: string, depth = 0): boolean {
    return (
      this.inputs.has(item) ||
      this.isLocalResource(item) ||
      (this.data.producers.get(item) ?? []).some((r) => this.canCraftHere(r)) ||
      (depth === 0 && (this.data.spoilsFrom.get(item) ?? []).some((s) => this.obtainableHere(s.item, depth + 1)))
    );
  }

  private isAvailable(r: RecipeData): boolean {
    return this.enabled.has(r.name);
  }

  private machineAvailable(m: MachineData): boolean {
    return m.items_to_place.some((item) => (this.data.producers.get(item) ?? []).some((r) => this.isAvailable(r)));
  }

  /** Recipe to make `item`, or undefined if it should be treated as a raw input. */
  chooseRecipe(item: string): RecipeData | undefined {
    if (this.inputs.has(item)) return undefined;
    const override = this.req.recipes?.[item];
    if (override) {
      const r = this.data.recipes.get(override);
      if (r) return r;
      this.warn(`Unknown recipe override '${override}' for ${item}`);
    }
    if (this.isLocalResource(item)) return undefined;
    let candidates = (this.data.producers.get(item) ?? []).filter((r) => this.canCraftHere(r));
    if (candidates.length === 0) {
      const spoils = this.data.spoilsFrom.get(item);
      if (spoils) {
        const from = spoils.map((s) => `${s.item} (${Math.round(s.seconds)}s)`).join(" or ");
        this.warn(`${item} is obtained by letting ${from} spoil; the planner does not model spoilage, so it is listed as an input`);
      } else if (this.req.surface && (this.data.mined.has(item) || this.data.tileFluids.has(item))) {
        this.warn(`${item} can't be mined or pumped on this surface and no recipe makes it here; it has to be imported`);
      }
      return undefined;
    }
    const unlocked = candidates.filter((r) => this.isAvailable(r));
    if (unlocked.length > 0) candidates = unlocked;
    else if (!this.req.allowLocked) {
      this.warn(`No researched recipe makes ${item}; treating it as an input (set allow_locked to plan anyway)`);
      return undefined;
    } else this.warn(`${item} needs a recipe that is not researched yet`);

    // Prefer recipes whose ingredients can be had here (e.g. molten iron from lava on Vulcanus rather
    // than from iron ore, which Vulcanus doesn't have), then the recipe named after the item.
    const missing = (r: RecipeData) => r.ingredients.filter((i) => !this.obtainableHere(i.name)).length;
    candidates.sort(
      (a, b) =>
        missing(a) - missing(b) ||
        Number(b.name === item) - Number(a.name === item) ||
        a.ingredients.length - b.ingredients.length,
    );
    const chosen = candidates[0]!;
    if (candidates.length > 1 && chosen.name !== item) {
      this.warn(`Several recipes make ${item}; using '${chosen.name}' (alternatives: ${candidates.slice(1, 6).map((r) => r.name).join(", ")})`);
    }
    return chosen;
  }

  chooseMachine(r: RecipeData): MachineData | undefined {
    const override = this.req.machines?.[r.name] ?? this.req.machines?.[r.category];
    if (override) {
      const m = this.data.machines.get(override);
      if (m) return m;
      this.warn(`Unknown machine override '${override}'`);
    }
    const cats = categoriesOf(r);
    const props = this.req.surface?.properties;
    let candidates = [...this.data.machines.values()].filter(
      (m) =>
        m.type !== "mining-drill" &&
        (m.crafting_categories ?? []).some((c) => cats.includes(c)) &&
        meetsConditions(m.surface_conditions, props),
    );
    if (candidates.length === 0) return undefined;
    // Best researched machine; if none is researched, the most basic one (the next thing to unlock).
    const score = (m: MachineData) => m.speed * (1 + Math.max(0, m.base_effect?.productivity ?? 0));
    const available = candidates.filter((m) => this.machineAvailable(m));
    if (available.length > 0) {
      return available.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
    }
    this.warn(`No researched machine can craft '${r.name}'`);
    return candidates.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))[0];
  }

  /** Total effects on a machine running a recipe (machine base effect + modules + beacons). */
  effects(machine: MachineData, recipe: RecipeData | undefined): Required<Effects> {
    const total: Required<Effects> = { speed: 0, productivity: 0, consumption: 0, pollution: 0, quality: 0 };
    const recipeAllows = (e: string) => recipe?.allowed_effects?.[e] ?? true;
    const machineAllows = (e: string) => machine.allowed_effects?.[e] ?? true;
    addEffects(total, machine.base_effect, 1, recipeAllows);

    const config = this.req.modules?.find((c) => c.machine === machine.name);
    if (config?.modules && machine.uses_module_effects) {
      if (config.modules.length > machine.module_slots) this.warn(`${machine.name} only has ${machine.module_slots} module slots`);
      for (const name of config.modules.slice(0, machine.module_slots)) {
        const mod = this.data.modules.get(name);
        if (!mod) this.warn(`Unknown module '${name}'`);
        else addEffects(total, mod.effects, 1, (e) => recipeAllows(e) && machineAllows(e));
      }
    }
    if (config?.beacons && config.beacons.count > 0 && machine.uses_beacon_effects) {
      const beacon = this.data.beacons.get(config.beacons.name);
      if (!beacon) this.warn(`Unknown beacon '${config.beacons.name}'`);
      else {
        const n = config.beacons.count;
        const profile = beacon.profile[Math.min(n, beacon.profile.length) - 1] ?? 1;
        const scale = n * beacon.distribution_effectivity * profile;
        for (const name of config.beacons.modules.slice(0, beacon.module_slots)) {
          const mod = this.data.modules.get(name);
          if (!mod) this.warn(`Unknown module '${name}'`);
          else addEffects(total, mod.effects, scale, (e) => recipeAllows(e) && machineAllows(e) && (beacon.allowed_effects?.[e] ?? true));
        }
      }
    }
    return total;
  }

  solve(): Plan {
    const { item: target, rate } = this.req;

    // 1. Choose a recipe per item, depth-first, cutting cycles.
    const chosen = new Map<string, RecipeData | undefined>();
    const order: string[] = []; // post-order: ingredients before the items that use them
    const onStack = new Set<string>();
    const visit = (item: string) => {
      if (chosen.has(item)) return;
      onStack.add(item);
      const recipe = this.chooseRecipe(item);
      chosen.set(item, recipe);
      for (const ing of recipe?.ingredients ?? []) {
        if (onStack.has(ing.name)) {
          this.warn(`Recipe loop: ${ing.name} is needed to make itself (via ${item}); loop demand is listed as an input`);
          continue;
        }
        visit(ing.name);
      }
      onStack.delete(item);
      order.push(item);
    };
    visit(target);

    // 2. Propagate demand from the target down (reverse post-order = users before ingredients).
    //    Byproducts of steps already planned are used first, and every use of a recipe is merged
    //    into one step, so a multi-output recipe (scrap recycling, oil processing) is sized once
    //    for whichever of its products needs the most crafts.
    const demand = new Map<string, number>([[target, rate]]);
    const rawInputs = new Map<string, number>();
    const spare = new Map<string, number>(); // byproduct output not yet used by anything
    const groups = new Map<string, StepGroup>();
    const processed = new Set<string>();
    const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);

    for (const item of [...order].reverse()) {
      processed.add(item);
      let need = demand.get(item) ?? 0;
      const credit = Math.min(need, spare.get(item) ?? 0);
      if (credit > 0) {
        spare.set(item, (spare.get(item) ?? 0) - credit);
        need -= credit;
      }
      if (need <= EPSILON) continue;
      const recipe = chosen.get(item);
      if (!recipe) {
        add(rawInputs, item, need);
        continue;
      }
      let group = groups.get(recipe.name);
      if (!group) {
        const machine = this.chooseMachine(recipe);
        if (!machine) {
          this.warn(`No machine can craft '${recipe.name}' here; listing ${item} as an input`);
          add(rawInputs, item, need);
          continue;
        }
        const fx = this.effects(machine, recipe);
        const productivity = Math.min(
          Math.max(0, fx.productivity + (this.force.recipe_productivity[recipe.name] ?? 0)),
          recipe.maximum_productivity,
        );
        group = { recipe, machine, fx, productivity, speed: machine.speed * Math.max(0.2, 1 + fx.speed), crafts: 0 };
        groups.set(recipe.name, group);
      }

      const product = recipe.products.find((p) => p.name === item)!;
      const consumedSelf = recipe.ingredients.find((i) => i.name === item)?.amount ?? 0;
      const crafts = need / (outputPerCraft(product, group.productivity) - consumedSelf);
      group.crafts += crafts;

      for (const ing of recipe.ingredients) {
        if (ing.name === item) continue;
        // Demand on an item that was already expanded can only come from a cut recipe loop.
        add(processed.has(ing.name) ? rawInputs : demand, ing.name, crafts * ing.amount);
      }
      for (const p of recipe.products) {
        if (p.name !== item) add(spare, p.name, crafts * outputPerCraft(p, group.productivity));
      }
    }

    const steps: PlanStep[] = [...groups.values()].map((g) => {
      const machines = (g.crafts * g.recipe.energy) / (60 * g.speed);
      return {
        recipe: g.recipe.name,
        machine: g.machine.name,
        machines,
        crafts_per_min: g.crafts,
        speed: g.speed,
        productivity: g.productivity,
        power_kw: Math.ceil(machines - EPSILON) * g.machine.energy_usage_kw * Math.max(0.2, 1 + g.fx.consumption),
        inputs: g.recipe.ingredients.map((i) => ({ name: i.name, rate: g.crafts * i.amount })),
        outputs: g.recipe.products.map((p) => ({ name: p.name, rate: g.crafts * outputPerCraft(p, g.productivity) })),
      };
    });
    const byproducts = new Map([...spare].filter(([, r]) => r > EPSILON));

    const mining = [...rawInputs].flatMap(([item, r]) => this.mining(item, r));
    for (const m of mining) {
      // Fluids required by mining (e.g. sulfuric acid for uranium) are additional raw inputs.
      const res = this.localResources(m.item).find((x) => x.name === m.resource);
      if (res?.required_fluid && res.fluid_amount) {
        const perOre = res.fluid_amount / 10 / expectedAmount(res.products.find((p) => p.name === m.item)!);
        add(rawInputs, res.required_fluid, m.rate * perOre);
      }
    }

    return {
      item: target,
      rate,
      steps,
      raw_inputs: [...rawInputs].map(([name, r]) => ({ name, rate: r })),
      byproducts: [...byproducts].map(([name, r]) => ({ name, rate: r })),
      mining,
      total_power_kw: steps.reduce((sum, s) => sum + s.power_kw, 0),
      warnings: this.warnings,
    };
  }

  private mining(item: string, rate: number): MiningStep[] {
    if (this.inputs.has(item)) return [];
    const resources = this.localResources(item);
    if (resources.length === 0) {
      return this.isLocalFluid(item) ? [{ resource: "offshore-pump", item, rate, note: "Pumped from tiles with offshore pumps" }] : [];
    }
    const res = resources[0]!;
    if (res.infinite) {
      return [{ resource: res.name, item, rate, note: "Output of fluid wells depends on the yield of each field" }];
    }
    const props = this.req.surface?.properties;
    const drills = [...this.data.machines.values()]
      .filter(
        (m) =>
          m.type === "mining-drill" &&
          (m.resource_categories ?? []).includes(res.category) &&
          meetsConditions(m.surface_conditions, props),
      )
      .sort((a, b) => Number(this.machineAvailable(b)) - Number(this.machineAvailable(a)) || b.speed - a.speed);
    const drill = drills[0];
    if (!drill) return [{ resource: res.name, item, rate, note: "No drill can mine this here" }];
    const fx = this.effects(drill, undefined);
    const productivity = Math.max(0, fx.productivity + this.force.mining_productivity);
    const product = res.products.find((p) => p.name === item)!;
    const perDrillPerMin = ((60 * drill.speed * Math.max(0.2, 1 + fx.speed)) / res.mining_time) * outputPerCraft(product, productivity);
    return [{ resource: res.name, item, rate, drill: drill.name, drills: rate / perDrillPerMin }];
  }
}

export function plan(data: PlannerData, force: ForceRecipeState, req: PlanRequest): Plan {
  return new Solver(data, force, req).solve();
}

export function recipesFor(data: PlannerData, force: ForceRecipeState, item: string) {
  const enabled = new Set(force.enabled_recipes);
  const describe = (r: RecipeData) => ({
    name: r.name,
    category: r.category,
    researched: enabled.has(r.name),
    seconds: r.energy,
    ingredients: r.ingredients.map((i) => `${i.amount} ${i.name}`),
    products: r.products.map((p) => `${+expectedAmount(p).toFixed(3)} ${p.name}`),
    surface_conditions: r.surface_conditions,
  });
  return {
    made_by: (data.producers.get(item) ?? []).map(describe),
    used_in: (data.consumers.get(item) ?? []).filter(isProductionRecipe).slice(0, 25).map((r) => r.name),
    mined_from: (data.mined.get(item) ?? []).map((r) => r.name),
    pumped_from_tiles: data.tileFluids.has(item),
    spoils_from: data.spoilsFrom.get(item) ?? [],
  };
}
