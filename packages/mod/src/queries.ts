// Read-only queries. Everything here respects fairness.ts: live entity details are only
// returned for chunks the force can currently see (radar coverage / nearby players).

import {
  Area,
  EntityDetails,
  EntitySummary,
  InventoryContents,
  Position,
  ProductionRow,
  RpcMethods,
  StatusSummaryRow,
  SurfaceInfo,
} from "@flh/protocol";
import { LuaEntity } from "factorio:runtime";
import {
  chunkKey,
  helperForce,
  hiddenChunksIn,
  isChunkCharted,
  isChunkVisible,
  isPositionCharted,
  isPositionVisible,
  requireKnownSurface,
} from "./fairness";

type Params<M extends keyof RpcMethods> = RpcMethods[M]["params"];
type Result<M extends keyof RpcMethods> = RpcMethods[M]["result"];

const DEFAULT_FIND_LIMIT = 200;
const MAX_FIND_LIMIT = 1000;
const STATUS_EXAMPLES = 3;

// ---- Bounds: every RPC runs inside one game tick, so none may scan a whole megabase. ----
// Measured on scripts/scenarios/flh-megabase; keep the tool descriptions in the bridge in sync.

/** Largest area (tiles per side) one entity query covers; radius queries at most half of it. */
export const MAX_AREA_SIZE = 512;
/** Most entities one query looks at in Lua (engine-side counting is much cheaper). */
export const MAX_ENTITIES = 5000;
/** Chunks game_info iterates over all surfaces together (~1 us each with the chart checks). */
const GAME_INFO_CHUNK_BUDGET = 12000;
const OVERVIEW_HINT = "; for the whole factory use factory_overview / search_factory, which answer from the factory index";

/** How far entities found by an area/radius query may stick out of it (biggest entity, rounded up). */
const ENTITY_REACH = 16;

interface Region {
  /** Where entities found by the query can be, for visibility checks. */
  box: Area;
  /** The area or position/radius part of a find_entities_filtered filter. */
  filter: { area?: [Position, Position]; position?: Position; radius?: number };
}

function grow(area: Area, by: number): Area {
  return {
    left_top: { x: area.left_top.x - by, y: area.left_top.y - by },
    right_bottom: { x: area.right_bottom.x + by, y: area.right_bottom.y + by },
  };
}

/**
 * The area (or with `circle`, position + radius) a query covers; refuses whole-surface queries and
 * oversized areas. Read-only queries (`overview`) point the model at the factory index instead.
 */
export function boundedRegion(
  params: { area?: Area; position?: Position; radius?: number },
  what: string,
  { circle = true, overview = true } = {},
): Region {
  const hint = overview ? OVERVIEW_HINT : "";
  if (params.area) {
    const { left_top: a, right_bottom: b } = params.area;
    const box = {
      left_top: { x: math.min(a.x, b.x), y: math.min(a.y, b.y) },
      right_bottom: { x: math.max(a.x, b.x), y: math.max(a.y, b.y) },
    };
    const width = math.ceil(box.right_bottom.x - box.left_top.x);
    const height = math.ceil(box.right_bottom.y - box.left_top.y);
    if (width > MAX_AREA_SIZE || height > MAX_AREA_SIZE) {
      throw `That area is ${width}x${height} tiles, but ${what} covers at most ${MAX_AREA_SIZE}x${MAX_AREA_SIZE} at a time: split it up${hint}`;
    }
    return { box: grow(box, ENTITY_REACH), filter: { area: [box.left_top, box.right_bottom] } };
  }
  if (circle && params.position) {
    const radius = params.radius ?? 0;
    if (radius > MAX_AREA_SIZE / 2) {
      throw `${what} searches a radius of at most ${MAX_AREA_SIZE / 2} tiles: use a smaller radius${hint}`;
    }
    const p = params.position;
    return { box: grow({ left_top: p, right_bottom: p }, radius + ENTITY_REACH), filter: { position: p, radius: params.radius } };
  }
  throw `${what} needs an area (at most ${MAX_AREA_SIZE}x${MAX_AREA_SIZE} tiles)${circle ? " or a position and radius" : ""}${hint}`;
}

function newLuaSet<T extends AnyNotNil>(...values: T[]): LuaSet<T> {
  const set = new LuaSet<T>();
  for (const value of values) set.add(value);
  return set;
}

let statusNames: LuaMap<number, string> | undefined;
function statusName(status: defines.entity_status | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (!statusNames) {
    statusNames = new LuaMap();
    for (const [name, value] of pairs(defines.entity_status as unknown as LuaTable<string, number>)) {
      statusNames.set(value, name);
    }
  }
  return statusNames.get(status as unknown as number) ?? tostring(status);
}

const CRAFTING_TYPES = newLuaSet("assembling-machine", "furnace", "rocket-silo");

function recipeOf(entity: LuaEntity): string | undefined {
  if (!CRAFTING_TYPES.has(entity.type)) return undefined;
  const [recipe] = entity.get_recipe();
  if (recipe) return recipe.name;
  if (entity.type === "furnace") return entity.previous_recipe?.name.name;
  return undefined;
}

function summarize(entity: LuaEntity): EntitySummary {
  return {
    name: entity.name,
    type: entity.type,
    position: { x: entity.position.x, y: entity.position.y },
    status: statusName(entity.status),
    recipe: recipeOf(entity),
    moves: entity.type === "inserter" ? { from: entity.pickup_target?.name, to: entity.drop_target?.name } : undefined,
  };
}

export function gameInfo(): Result<"game_info"> {
  const force = helperForce();
  const surfaces: SurfaceInfo[] = [];
  const perSurface = math.max(256, math.floor(GAME_INFO_CHUNK_BUDGET / game.surfaces.length()));
  for (const [, surface] of game.surfaces) {
    if (force.get_surface_hidden(surface)) continue; // e.g. the helper's own scratch surface
    let charted = 0;
    let visible = 0;
    let scanned = 0;
    let partial = false;
    for (const chunk of surface.get_chunks()) {
      if (++scanned > perSurface) {
        partial = true;
        break;
      }
      if (isChunkCharted(force, surface, chunk)) {
        charted++;
        if (isChunkVisible(force, surface, chunk)) visible++;
      }
    }
    if (charted === 0) continue;
    surfaces.push({
      name: surface.name,
      planet: surface.planet?.name,
      platform: surface.platform?.name,
      charted_chunks: charted,
      visible_chunks: visible,
      counts_partial: partial || undefined,
    });
  }
  const players: Result<"game_info">["players"] = [];
  for (const [, player] of game.players) {
    if (player.force !== force) continue;
    players.push({
      index: player.index,
      name: player.name,
      connected: player.connected,
      surface: player.surface.name,
      position: { x: player.position.x, y: player.position.y },
    });
  }
  return {
    tick: game.tick,
    force: force.name,
    current_research: force.current_research?.name,
    players,
    surfaces,
  };
}

const WINDOWS = {
  "1m": { index: defines.flow_precision_index.one_minute, minutes: 1 },
  "10m": { index: defines.flow_precision_index.ten_minutes, minutes: 10 },
  "1h": { index: defines.flow_precision_index.one_hour, minutes: 60 },
} as const;

export function production(params: Params<"production">): Result<"production"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const window = WINDOWS[params.window] ?? WINDOWS["10m"];
  const rows: ProductionRow[] = [];

  if (params.items) {
    const unknown = params.items.filter((name) => !prototypes.item[name] && !prototypes.fluid[name]);
    if (unknown.length > 0) throw `Unknown item or fluid: ${unknown.join(", ")}`;
  }
  for (const [stats, isFluidStats] of [
    [force.get_item_production_statistics(surface), false],
    [force.get_fluid_production_statistics(surface), true],
  ] as const) {
    const names = new LuaSet<string>();
    if (params.items) {
      // Item and fluid statistics each reject the other kind's names.
      const known = isFluidStats ? prototypes.fluid : prototypes.item;
      for (const name of params.items) if (known[name]) names.add(name);
    } else {
      for (const [name] of pairs(stats.input_counts)) names.add(name as string);
      for (const [name] of pairs(stats.output_counts)) names.add(name as string);
    }
    for (const name of names) {
      const flow = (category: "input" | "output") =>
        stats.get_flow_count({ name, category, precision_index: window.index, count: true }) / window.minutes;
      const produced = flow("input");
      const consumed = flow("output");
      if (params.items || produced > 0 || consumed > 0) {
        rows.push({ name, produced_per_min: produced, consumed_per_min: consumed });
      }
    }
  }

  rows.sort((a, b) => b.produced_per_min + b.consumed_per_min - (a.produced_per_min + a.consumed_per_min));
  const limit = params.limit ?? 50;
  return rows.slice(0, limit);
}

export function findEntities(params: Params<"find_entities">): Result<"find_entities"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const limit = math.min(params.limit ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
  const region = boundedRegion(params, "find_entities");
  const filter = {
    ...region.filter,
    name: params.name as string | string[] | undefined,
    type: params.type as string | string[] | undefined,
    force: params.all_forces ? undefined : force,
  };
  const hidden = hiddenChunksIn(force, surface, region.box);
  // All visible (the usual case): let the engine stop at the limit. Otherwise look at up to
  // MAX_ENTITIES and leave out those in chunks the force can't see.
  const found = surface.find_entities_filtered({ ...filter, limit: hidden ? MAX_ENTITIES + 1 : limit + 1 });
  const result: EntitySummary[] = [];
  let skipped = 0;
  let truncated = found.length > (hidden ? MAX_ENTITIES : limit);
  for (let i = 0; i < math.min(found.length, MAX_ENTITIES); i++) {
    const entity = found[i];
    if (hidden?.has(chunkKey(entity.position))) skipped++;
    else if (result.length < limit) result.push(summarize(entity));
    else truncated = true;
  }
  // Engine-side count, so the model knows how much it is not seeing.
  const total = truncated ? surface.count_entities_filtered(filter) : undefined;
  return { entities: result, truncated, total, skipped_not_visible: skipped };
}

const STATUS_TYPE_CANDIDATES = [
  "assembling-machine", "furnace", "rocket-silo", "mining-drill", "lab", "inserter", "boiler", "generator",
  "burner-generator", "reactor", "fusion-reactor", "fusion-generator", "beacon", "roboport", "radar", "pump",
  "offshore-pump", "agricultural-tower", "asteroid-collector", "ammo-turret", "electric-turret", "fluid-turret",
  "artillery-turret", "thruster", "lightning-attractor", "cargo-landing-pad", "space-platform-hub", "train-stop",
];
let statusTypes: string[] | undefined;
/** Entity types with a meaningful status: machines, not belts, poles, pipes or chests. */
function statusTypeList(): string[] {
  if (!statusTypes) {
    const existing = new LuaSet<string>();
    for (const [, prototype] of prototypes.entity) existing.add(prototype.type);
    statusTypes = STATUS_TYPE_CANDIDATES.filter((type) => existing.has(type));
  }
  return statusTypes;
}

export function statusSummary(params: Params<"status_summary">): Result<"status_summary"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const region = boundedRegion(params, "status_summary", { circle: false });
  let type = params.type as string | string[] | undefined;
  if (type === undefined && params.name === undefined) {
    type = params.recipe ? ["assembling-machine", "furnace", "rocket-silo"] : statusTypeList();
  }
  const entities = surface.find_entities_filtered({
    ...region.filter,
    name: params.name as string | string[] | undefined,
    type,
    force,
    limit: MAX_ENTITIES + 1,
  });
  if (entities.length > MAX_ENTITIES) {
    throw `More than ${MAX_ENTITIES} matching entities in that area: use a smaller area or filter by name, type or recipe${OVERVIEW_HINT}`;
  }
  const hidden = hiddenChunksIn(force, surface, region.box);
  let skipped = 0;
  const rows = new LuaMap<string, StatusSummaryRow>();
  for (const entity of entities) {
    if (hidden?.has(chunkKey(entity.position))) {
      skipped++;
      continue;
    }
    const recipe = recipeOf(entity);
    if (params.recipe && recipe !== params.recipe) continue;
    const status = statusName(entity.status) ?? "none";
    const key = `${entity.name}|${recipe ?? ""}|${status}`;
    let row = rows.get(key);
    if (!row) {
      row = { name: entity.name, recipe, status, count: 0, examples: [] };
      rows.set(key, row);
    }
    row.count++;
    if (row.examples.length < STATUS_EXAMPLES) row.examples.push({ x: entity.position.x, y: entity.position.y });
  }
  const list: StatusSummaryRow[] = [];
  for (const [, row] of rows) list.push(row);
  list.sort((a, b) => b.count - a.count);
  return { rows: list, skipped_not_visible: skipped };
}

function inventories(entity: LuaEntity): InventoryContents | undefined {
  const max = entity.get_max_inventory_index();
  let result: InventoryContents | undefined;
  for (let i = 1; i <= max; i++) {
    const inventory = entity.get_inventory(i as defines.inventory);
    if (!inventory) continue;
    const contents = inventory.get_contents().map((c) => ({
      name: c.name as string,
      quality: c.quality === "normal" ? undefined : (c.quality as string),
      count: c.count,
    }));
    result ??= {};
    result[inventory.name ?? tostring(i)] = contents;
  }
  return result;
}

export function inspectEntity(params: Params<"inspect_entity">): Result<"inspect_entity"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);

  const entity: LuaEntity | undefined = surface.find_entities_filtered({
    position: params.position,
    radius: 0.5,
    name: params.name,
    limit: 1,
  })[0];
  if (!entity || !entity.valid) throw "No entity found there";
  if (!isPositionVisible(force, surface, entity.position)) {
    throw isPositionCharted(force, surface, entity.position)
      ? "That area is charted but not currently visible (no radar coverage), so live details are unknown"
      : "That area has not been charted";
  }

  const details: EntityDetails = {
    ...summarize(entity),
    surface: surface.name,
    health: entity.health,
    energy: entity.energy,
    electric_network_id: entity.electric_network_id,
    inventories: inventories(entity),
  };

  if (CRAFTING_TYPES.has(entity.type)) {
    details.crafting_progress = entity.crafting_progress;
    details.products_finished = entity.products_finished;
  }

  if (entity.fluidbox.length > 0) {
    details.fluids = [];
    for (let i = 1; i <= entity.fluidbox.length; i++) {
      const fluid = entity.fluidbox[i - 1];
      if (fluid) details.fluids.push({ name: fluid.name, amount: fluid.amount, temperature: fluid.temperature });
    }
  }

  if (entity.type === "inserter") {
    if (entity.held_stack.valid_for_read) {
      details.held_stack = { name: entity.held_stack.name, count: entity.held_stack.count };
    }
    const pickup = entity.pickup_position;
    const drop = entity.drop_position;
    details.pickup = { position: { x: pickup.x, y: pickup.y }, entity: entity.pickup_target?.name };
    details.drop = { position: { x: drop.x, y: drop.y }, entity: entity.drop_target?.name };
  }

  if (entity.type === "transport-belt" || entity.type === "underground-belt" || entity.type === "splitter") {
    details.belt_lines = [];
    const lines = entity.get_max_transport_line_index();
    for (let i = 1; i <= lines; i++) {
      details.belt_lines.push(
        entity.get_transport_line(i).get_contents().map((c) => ({ name: c.name as string, count: c.count })),
      );
    }
  }

  return details;
}
