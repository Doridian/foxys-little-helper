// Exports static prototype data for the planner. This is public game knowledge (it is all in
// Factoriopedia), so no fairness checks are needed beyond only reporting the helper force's
// own research state.

import {
  AllowedEffects,
  BeaconData,
  Effects,
  ForceRecipeState,
  IngredientData,
  MachineData,
  ModuleData,
  PrototypeData,
  ProductData,
  RecipeData,
  ResourceData,
  RpcMethods,
  SurfaceConditionData,
  SurfaceInfoData,
} from "@flh/protocol";
import { Ingredient, LuaEntityPrototype, MapGenSettings, ModuleEffects, Product, SurfaceCondition } from "factorio:runtime";
import { helperForce } from "./fairness";

function keys(table: Record<string, unknown> | undefined): string[] | undefined {
  if (!table) return undefined;
  const result: string[] = [];
  for (const [key] of pairs(table)) result.push(key);
  return result;
}

function effects(e: ModuleEffects | undefined): Effects | undefined {
  if (!e) return undefined;
  return { speed: e.speed, productivity: e.productivity, consumption: e.consumption, pollution: e.pollution, quality: e.quality };
}

function allowed(a: Record<string, boolean> | undefined): AllowedEffects | undefined {
  return a as AllowedEffects | undefined;
}

function conditions(c: SurfaceCondition[] | undefined): SurfaceConditionData[] | undefined {
  return c?.map((x) => ({ property: x.property, min: x.min, max: x.max }));
}

function ingredients(list: Ingredient[]): IngredientData[] {
  return list.map((i) => ({ type: i.type === "fluid" ? "fluid" : "item", name: i.name, amount: i.amount }));
}

function products(list: Product[] | undefined): ProductData[] {
  if (!list) return [];
  return list.map((p) => ({
    type: p.type,
    name: p.name,
    amount: p.amount,
    amount_min: p.amount_min,
    amount_max: p.amount_max,
    probability: p.probability,
    ignored_by_productivity: p.ignored_by_productivity,
    extra_count_fraction: p.type === "item" ? p.extra_count_fraction : undefined,
  }));
}

function placedBy(entity: LuaEntityPrototype): string[] {
  return (entity.items_to_place_this ?? []).map((i) => i.name);
}

const J_PER_TICK_TO_KW = 60 / 1000;

export function prototypeData(): RpcMethods["prototypes"]["result"] {
  const recipes: RecipeData[] = [];
  for (const [, recipe] of prototypes.recipe) {
    if (recipe.name.startsWith("parameter-")) continue;
    recipes.push({
      name: recipe.name,
      category: recipe.category,
      additional_categories: recipe.additional_categories.length > 0 ? recipe.additional_categories : undefined,
      subgroup: recipe.subgroup.name,
      energy: recipe.energy,
      ingredients: ingredients(recipe.ingredients),
      products: products(recipe.products),
      hidden: recipe.hidden,
      allowed_effects: allowed(recipe.allowed_effects),
      maximum_productivity: recipe.maximum_productivity,
      surface_conditions: conditions(recipe.surface_conditions),
    });
  }

  const machines: MachineData[] = [];
  const beacons: BeaconData[] = [];
  const resources: ResourceData[] = [];
  for (const [, entity] of prototypes.get_entity_filtered([
    { filter: "type", type: ["assembling-machine", "furnace", "mining-drill", "beacon", "resource"] },
  ])) {
    if (entity.hidden) continue;
    if (entity.type === "resource") {
      const mineable = entity.mineable_properties;
      resources.push({
        name: entity.name,
        category: entity.resource_category ?? "basic-solid",
        mining_time: mineable.mining_time,
        products: products(mineable.products),
        infinite: entity.infinite_resource ?? false,
        required_fluid: mineable.required_fluid,
        fluid_amount: mineable.fluid_amount,
      });
    } else if (entity.type === "beacon") {
      beacons.push({
        name: entity.name,
        distribution_effectivity: entity.distribution_effectivity ?? 1,
        profile: entity.profile ?? [1],
        module_slots: entity.module_inventory_size ?? 0,
        allowed_effects: allowed(entity.allowed_effects),
        allowed_module_categories: keys(entity.allowed_module_categories),
        items_to_place: placedBy(entity),
      });
    } else {
      const isDrill = entity.type === "mining-drill";
      const receiver = entity.effect_receiver;
      machines.push({
        name: entity.name,
        type: entity.type as MachineData["type"],
        crafting_categories: keys(entity.crafting_categories),
        resource_categories: keys(entity.resource_categories),
        speed: isDrill ? (entity.mining_speed ?? 0) : entity.get_crafting_speed(),
        module_slots: entity.module_inventory_size ?? 0,
        allowed_effects: allowed(entity.allowed_effects),
        allowed_module_categories: keys(entity.allowed_module_categories),
        base_effect: effects(receiver?.base_effect),
        uses_module_effects: receiver?.uses_module_effects ?? true,
        uses_beacon_effects: receiver?.uses_beacon_effects ?? true,
        energy_usage_kw: (entity.energy_usage ?? 0) * J_PER_TICK_TO_KW,
        surface_conditions: conditions(entity.surface_conditions),
        items_to_place: placedBy(entity),
        size: { width: entity.tile_width, height: entity.tile_height },
      });
    }
  }

  const modules: ModuleData[] = [];
  const spoilage: PrototypeData["spoilage"] = [];
  for (const [, item] of prototypes.item) {
    if (item.type === "module" && !item.hidden) {
      modules.push({ name: item.name, category: item.category ?? "", effects: effects(item.module_effects) ?? {} });
    }
    if (item.spoil_result) {
      spoilage.push({ item: item.name, result: item.spoil_result.name, seconds: item.get_spoil_ticks() / 60 });
    }
  }

  const tileFluids = new LuaSet<string>();
  for (const [, tile] of prototypes.tile) {
    if (tile.fluid) tileFluids.add(tile.fluid.name);
  }
  const tile_fluids: string[] = [];
  for (const name of tileFluids) tile_fluids.push(name);

  const data: PrototypeData = { recipes, machines, beacons, modules, resources, tile_fluids, spoilage };
  return data;
}

export function forceRecipes(): ForceRecipeState {
  const force = helperForce();
  const enabled: string[] = [];
  const productivity: Record<string, number> = {};
  for (const [name, recipe] of pairs(force.recipes)) {
    if (recipe.enabled) enabled.push(name);
    if (recipe.productivity_bonus !== 0) productivity[name] = recipe.productivity_bonus;
  }
  return {
    enabled_recipes: enabled,
    recipe_productivity: productivity,
    mining_productivity: force.mining_drill_productivity_bonus,
  };
}

/**
 * Surface properties (pressure, gravity, magnetic field...) plus the resources and tile fluids its
 * map generation places. Accepts an existing surface or a planet that may not have been visited
 * yet: this is all public knowledge, and planning ahead for a planet is something players do too.
 */
export function surfaceInfo(params: RpcMethods["surface_info"]["params"]): SurfaceInfoData {
  const properties: Record<string, number> = {};
  let mapGen: MapGenSettings | undefined;
  const surface = game.get_surface(params.surface);
  if (surface) {
    for (const [name] of prototypes.surface_property) properties[name] = surface.get_property(name);
    mapGen = surface.map_gen_settings;
  } else {
    const location = prototypes.space_location[params.surface];
    if (!location) throw `Unknown surface or planet '${params.surface}'`;
    for (const [name, property] of prototypes.surface_property) {
      properties[name] = location.surface_properties?.[name] ?? property.default_value;
    }
    mapGen = location.map_gen_settings;
  }

  const resources: string[] = [];
  for (const [name] of pairs(mapGen?.autoplace_settings?.entity?.settings ?? {})) {
    if (prototypes.entity[name]?.type === "resource") resources.push(name);
  }
  const fluids = new LuaSet<string>();
  for (const [name] of pairs(mapGen?.autoplace_settings?.tile?.settings ?? {})) {
    const fluid = prototypes.tile[name]?.fluid;
    if (fluid) fluids.add(fluid.name);
  }
  const tile_fluids: string[] = [];
  for (const name of fluids) tile_fluids.push(name);
  return { properties, resources, tile_fluids };
}
