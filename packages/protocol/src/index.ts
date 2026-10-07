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
  | { type: "player_cancel"; tick: number; player_index: number; player_name: string }
  | {
      type: "area_selected";
      tick: number;
      player_index: number;
      player_name: string;
      surface: string;
      area: Area;
      entities: { [name: string]: number };
    }
  | {
      type: "proposal_resolved";
      tick: number;
      player_index: number;
      player_name: string;
      id: number;
      outcome: "approved" | "rejected" | "blueprint";
      built?: number;
    };

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
  name: string;
  type: string;
  position: Position;
  status?: string;
  recipe?: string;
  /** Inserters: what they take from and put into (entity names), since direction is easy to misread. */
  moves?: { from?: string; to?: string };
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
  /** For inserters: what they are holding, and where they pick up from and drop to. */
  held_stack?: { name: string; count: number };
  pickup?: { position: Position; entity?: string };
  drop?: { position: Position; entity?: string };
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
  size: { width: number; height: number };
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

// ---- Acting: blueprints, proposals and actions ----

export type Direction = "north" | "east" | "south" | "west";

/** A blueprint entity as Factorio's blueprint format describes it (passed through untouched). */
export interface BlueprintEntityData {
  entity_number: number;
  name: string;
  position: Position;
  direction?: number;
  recipe?: string;
  [key: string]: unknown;
}

export type BlueprintSource =
  /** A blueprint exchange string. */
  | { kind: "string"; string: string }
  /** Raw blueprint entities (e.g. from a layout generator). */
  | { kind: "entities"; entities: BlueprintEntityData[]; label?: string }
  /** A blueprint from the in-game library (see list_blueprints). */
  | { kind: "library"; id: string }
  /** Copy of an existing, visible area of the factory. */
  | { kind: "copy"; surface: string; area: Area };

export type ItemCount = { name: string; quality?: string; count: number };

export interface ProposalSummary {
  id: number;
  surface: string;
  /** World area the build covers. */
  area: Area;
  entities: { [name: string]: number };
  /** Entities dropped because players can't build them (script-only entities like infinity chests). */
  removed_unbuildable: { [name: string]: number };
  conflict_count: number;
  conflicts: { name: string; position: Position }[];
  /** Trees and rocks in the area; building marks them for deconstruction. */
  obstacles: number;
  cost: ItemCount[];
  /** Whether a construction robot network covers the area, and what it lacks to build everything. */
  construction: { covered: boolean; missing: ItemCount[] };
}

export interface ActionResult {
  action_id: number;
  count: number;
}

export interface LibraryBlueprint {
  id: string;
  label?: string;
  description?: string;
  /** Path of book labels containing it, if any. */
  book?: string;
  size: { width: number; height: number };
  entities: { [name: string]: number };
  recipes: { [recipe: string]: number };
}

// ---- Factory index (mod maintains per-chunk summaries; bridge mirrors them and builds blocks) ----

export interface IndexedCrafters {
  recipe: string;
  machine: string;
  count: number;
  /** Status name -> count; only present when the chunk was visible when summarised. */
  statuses?: { [status: string]: number };
}

export interface IndexedMiners {
  resource: string;
  machine: string;
  count: number;
  statuses?: { [status: string]: number };
}

/** Everything of the helper's force in one 32x32 chunk, summarised. */
export interface ChunkSummary {
  surface: string;
  /** Chunk coordinates (tile = chunk * 32). */
  x: number;
  y: number;
  /** Global index revision at which this summary was written. */
  revision: number;
  tick: number;
  /** Live statuses were recorded (the chunk was visible when summarised). */
  visible: boolean;
  /** Crafting machines (assemblers, furnaces by current or last recipe, chemical plants, refineries, silos...) by recipe. */
  crafters: IndexedCrafters[];
  /** Mining drills and pumpjacks by mined resource. */
  miners: IndexedMiners[];
  labs: number;
  /** All other entities of ours by prototype name: belts, inserters, poles, chests, roboports... */
  entities: { [name: string]: number };
  /** Train stop names in this chunk. */
  train_stops?: string[];
}

export interface RpcMethods {
  /** Overall state of the index: current revision and per-surface coverage. */
  index_status: {
    params: Record<string, never>;
    result: {
      revision: number;
      surfaces: { name: string; chunks: number; pending: number; last_full_pass_tick?: number }[];
    };
  };
  /**
   * Chunk summaries written after revision `since` (0 = everything), oldest first, at most `limit`
   * (default 500). `removed` lists chunks that no longer contain anything of ours. Call again with
   * the returned revision while `more` is true.
   */
  index_changes: {
    params: { since: number; limit?: number };
    result: {
      revision: number;
      chunks: ChunkSummary[];
      removed: { surface: string; x: number; y: number; revision: number }[];
      more: boolean;
    };
  };
  propose_build: {
    params: {
      surface: string;
      source: BlueprintSource;
      /** Top-left corner of the build's bounding box. */
      position: Position;
      direction?: Direction;
      label?: string;
      /** Player who sees the preview and gets the approval dialog. */
      player_index?: number;
    };
    result: ProposalSummary;
  };
  resolve_proposal: {
    params: { id: number; outcome: "approved" | "rejected" | "blueprint"; player_index?: number };
    result: { built: number; action_id?: number };
  };
  list_proposals: { params: Record<string, never>; result: { id: number; label: string; surface: string; area: Area }[] };
  give_blueprint: {
    params: { player_index: number; source: BlueprintSource; label?: string };
    result: { entities: number; removed_unbuildable: { [name: string]: number } };
  };
  undo_action: {
    params: { action_id?: number };
    result: { action_id: number; ghosts_removed: number; deconstruction_ordered: number; deconstruction_cancelled: number; recipes_restored: number };
  };
  deconstruct: {
    params: { surface: string; area: Area; name?: string | string[]; type?: string | string[]; player_index?: number };
    result: ActionResult;
  };
  set_recipe: {
    params: { surface: string; position: Position; recipe: string; player_index?: number };
    result: ActionResult & { previous?: string };
  };
  find_space: {
    params: { surface: string; width: number; height: number; near: Position; max_distance?: number };
    result: { left_top: Position; distance: number } | { not_found: true };
  };
  add_library_chest: { params: { surface: string; position: Position }; result: { chests: number } };
  list_blueprints: { params: { player_index?: number }; result: LibraryBlueprint[] };
  /** Progress of a player's request, shown in their FLH panel. `done` clears it. */
  set_status: { params: { player_index: number; state: "thinking" | "done"; detail?: string }; result: true };
  prototypes: { params: Record<string, never>; result: PrototypeData };
  force_recipes: { params: Record<string, never>; result: ForceRecipeState };
  surface_info: { params: { surface: string }; result: SurfaceInfoData };
  poll_events: { params: Record<string, never>; result: GameEvent[] };
  /** Chat message from the helper; `player_index` is whose conversation it belongs to. */
  say: { params: { player_index?: number; message: string; private?: boolean }; result: true };
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
      /** Also include entities of other forces: trees, rocks, enemies (default: only our own). */
      all_forces?: boolean;
    };
    result: { entities: EntitySummary[]; truncated: boolean; skipped_not_visible: number };
  };
  status_summary: {
    params: { surface: string; area?: Area; name?: string | string[]; type?: string | string[]; recipe?: string };
    result: { rows: StatusSummaryRow[]; skipped_not_visible: number };
  };
  inspect_entity: {
    params: { surface: string; position: Position; name?: string };
    result: EntityDetails;
  };
}

export type RpcMethod = keyof RpcMethods;
