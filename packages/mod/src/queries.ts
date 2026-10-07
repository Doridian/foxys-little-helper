// Read-only queries. Everything here respects fairness.ts: live entity details are only
// returned for chunks the force can currently see (radar coverage / nearby players).

import {
  EntityDetails,
  EntitySummary,
  InventoryContents,
  ProductionRow,
  RpcMethods,
  StatusSummaryRow,
  SurfaceInfo,
} from "@flh/protocol";
import { LuaEntity, LuaForce, LuaSurface } from "factorio:runtime";
import { helperForce, isPositionCharted, isPositionVisible, requireKnownSurface } from "./fairness";

type Params<M extends keyof RpcMethods> = RpcMethods[M]["params"];
type Result<M extends keyof RpcMethods> = RpcMethods[M]["result"];

const DEFAULT_FIND_LIMIT = 200;
const MAX_FIND_LIMIT = 1000;
const STATUS_EXAMPLES = 3;

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
  for (const [, surface] of game.surfaces) {
    let charted = 0;
    let visible = 0;
    for (const chunk of surface.get_chunks()) {
      if (force.is_chunk_charted(surface, chunk)) {
        charted++;
        if (force.is_chunk_visible(surface, chunk)) visible++;
      }
    }
    if (charted === 0) continue;
    surfaces.push({
      name: surface.name,
      planet: surface.planet?.name,
      platform: surface.platform?.name,
      charted_chunks: charted,
      visible_chunks: visible,
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

function findVisible(
  force: LuaForce,
  surface: LuaSurface,
  filter: Params<"find_entities">,
): { entities: LuaEntity[]; skipped: number } {
  const found = surface.find_entities_filtered({
    area: filter.area ? [filter.area.left_top, filter.area.right_bottom] : undefined,
    position: filter.position,
    radius: filter.radius,
    name: filter.name as string | string[] | undefined,
    type: filter.type as string | string[] | undefined,
    force: filter.all_forces ? undefined : force,
  });
  const entities: LuaEntity[] = [];
  let skipped = 0;
  for (const entity of found) {
    if (isPositionVisible(force, surface, entity.position)) entities.push(entity);
    else skipped++;
  }
  return { entities, skipped };
}

export function findEntities(params: Params<"find_entities">): Result<"find_entities"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const limit = math.min(params.limit ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
  const { entities, skipped } = findVisible(force, surface, params);
  const result: EntitySummary[] = [];
  for (const entity of entities) {
    if (result.length >= limit) break;
    result.push(summarize(entity));
  }
  return { entities: result, truncated: entities.length > limit, skipped_not_visible: skipped };
}

export function statusSummary(params: Params<"status_summary">): Result<"status_summary"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const { entities, skipped } = findVisible(force, surface, params);
  const rows = new LuaMap<string, StatusSummaryRow>();
  for (const entity of entities) {
    if (entity.force !== force) continue;
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
