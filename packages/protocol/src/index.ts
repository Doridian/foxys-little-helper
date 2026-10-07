// Shared, type-only definitions for the RPC protocol between the bridge and the mod.
// This file is consumed by both TypeScript (bridge) and TypeScriptToLua (mod), so it must
// not contain any runtime code.

export type Position = { x: number; y: number };
export type Area = { left_top: Position; right_bottom: Position };

/** Sent by the bridge as the parameter of `/flh-rpc`. */
export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: number;
  method: M;
  params: RpcMethods[M]["params"];
}

/** Printed back over RCON by the mod. */
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type GameEvent =
  | { type: "player_message"; tick: number; player_index: number; player_name: string; message: string }
  | { type: "player_cancel"; tick: number; player_index: number; player_name: string };

export interface SurfaceInfo {
  name: string;
  /** Planet name if this surface belongs to a planet. */
  planet?: string;
  /** Space platform name if this surface is a platform. */
  platform?: string;
  charted_chunks: number;
  visible_chunks: number;
}

export interface EntitySummary {
  unit_number?: number;
  name: string;
  type: string;
  position: Position;
  status?: string;
  recipe?: string;
}

export interface InventoryContents {
  [inventory: string]: { name: string; quality?: string; count: number }[];
}

export interface EntityDetails extends EntitySummary {
  surface: string;
  health?: number;
  crafting_progress?: number;
  products_finished?: number;
  energy?: number;
  electric_network_id?: number;
  inventories?: InventoryContents;
  fluids?: { name: string; amount: number; temperature?: number }[];
  /** For inserters: what they are holding. */
  held_stack?: { name: string; count: number };
  /** For belts: items currently on each transport line. */
  belt_lines?: { name: string; count: number }[][];
}

export interface StatusSummaryRow {
  name: string;
  recipe?: string;
  status: string;
  count: number;
  /** A few example positions so the agent can drill in. */
  examples: Position[];
}

export interface ProductionRow {
  name: string;
  /** Items (or fluid units) per minute averaged over the requested window. */
  produced_per_min: number;
  consumed_per_min: number;
}

// ---- Prototype data for the planner. Static per mod set, so the bridge caches it. ----

export type Effects = { speed?: number; productivity?: number; consumption?: number; pollution?: number; quality?: number };
export type AllowedEffects = { [effect: string]: boolean };
export interface SurfaceConditionData { property: string; min: number; max: number }

export interface IngredientData { type: "item" | "fluid"; name: string; amount: number }
export interface ProductData {
  type: "item" | "fluid";
  name: string;
  amount?: number;
  amount_min?: number;
  amount_max?: number;
  probability: number;
  ignored_by_productivity?: number;
  extra_count_fraction?: number;
}

export interface RecipeData {
  name: string;
  category: string;
  additional_categories?: string[];
  subgroup: string;
  /** Crafting time in seconds at crafting speed 1. */
  energy: number;
  ingredients: IngredientData[];
  products: ProductData[];
  hidden: boolean;
  allowed_effects?: AllowedEffects;
  maximum_productivity: number;
  surface_conditions?: SurfaceConditionData[];
}

export interface MachineData {
  name: string;
  type: "assembling-machine" | "furnace" | "mining-drill";
  crafting_categories?: string[];
  resource_categories?: string[];
  /** Crafting speed (crafting machines) or mining speed (drills), normal quality. */
  speed: number;
  module_slots: number;
  allowed_effects?: AllowedEffects;
  allowed_module_categories?: string[];
  base_effect?: Effects;
  uses_module_effects: boolean;
  uses_beacon_effects: boolean;
  energy_usage_kw: number;
  surface_conditions?: SurfaceConditionData[];
  items_to_place: string[];
}

export interface BeaconData {
  name: string;
  distribution_effectivity: number;
  /** Multiplier by number of beacons affecting a machine (index 0 = one beacon). */
  profile: number[];
  module_slots: number;
  allowed_effects?: AllowedEffects;
  allowed_module_categories?: string[];
  items_to_place: string[];
}

export interface ModuleData { name: string; category: string; effects: Effects }

export interface ResourceData {
  name: string;
  category: string;
  mining_time: number;
  products: ProductData[];
  infinite: boolean;
  required_fluid?: string;
  fluid_amount?: number;
}

export interface PrototypeData {
  recipes: RecipeData[];
  machines: MachineData[];
  beacons: BeaconData[];
  modules: ModuleData[];
  resources: ResourceData[];
  /** Fluids that offshore pumps can pump from tiles (water, lava, ...). */
  tile_fluids: string[];
  /** Items that turn into another item when they spoil (e.g. iron-bacteria -> iron-ore on Gleba). */
  spoilage: { item: string; result: string; seconds: number }[];
}

/** Research-dependent state; changes as the game progresses, so fetched fresh per plan. */
export interface ForceRecipeState {
  enabled_recipes: string[];
  /** Research productivity bonus per recipe, only non-zero entries. */
  recipe_productivity: { [recipe: string]: number };
  mining_productivity: number;
}

/** What a surface (or not-yet-visited planet) offers, from its properties and map generation. */
export interface SurfaceInfoData {
  properties: { [property: string]: number };
  /** Resource entities placed by map generation, e.g. iron-ore, sulfuric-acid-geyser. */
  resources: string[];
  /** Fluids available from tiles placed by map generation, e.g. water, lava. */
  tile_fluids: string[];
}

export interface RpcMethods {
  prototypes: { params: Record<string, never>; result: PrototypeData };
  force_recipes: { params: Record<string, never>; result: ForceRecipeState };
  surface_info: { params: { surface: string }; result: SurfaceInfoData };
  poll_events: { params: Record<string, never>; result: GameEvent[] };
  say: { params: { player_index?: number; message: string }; result: true };
  game_info: {
    params: Record<string, never>;
    result: {
      tick: number;
      force: string;
      current_research?: string;
      players: { index: number; name: string; connected: boolean; surface: string; position: Position }[];
      surfaces: SurfaceInfo[];
    };
  };
  production: {
    params: { surface: string; items?: string[]; window: "1m" | "10m" | "1h"; limit?: number };
    result: ProductionRow[];
  };
  find_entities: {
    params: {
      surface: string;
      area?: Area;
      position?: Position;
      radius?: number;
      name?: string | string[];
      type?: string | string[];
      limit?: number;
    };
    result: { entities: EntitySummary[]; truncated: boolean; skipped_not_visible: number };
  };
  status_summary: {
    params: { surface: string; area?: Area; name?: string | string[]; type?: string | string[]; recipe?: string };
    result: { rows: StatusSummaryRow[]; skipped_not_visible: number };
  };
  inspect_entity: {
    params: { surface: string; unit_number?: number; position?: Position; name?: string };
    result: EntityDetails;
  };
}

export type RpcMethod = keyof RpcMethods;
