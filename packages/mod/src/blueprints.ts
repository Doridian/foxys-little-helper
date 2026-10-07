// Blueprint handling: loading designs from any source into a scratch item stack, removing
// entities players can't build, measuring exactly where a build will land (dry run on a hidden
// lab-tile surface), and indexing the in-game blueprint library.

import { Area, BlueprintSource, Direction, LibraryBlueprint, Position } from "@flh/protocol";
import { BlueprintEntity, BlueprintEntityWrite, LuaItemStack, LuaPlayer, LuaSurface } from "factorio:runtime";
import { chunkOf, helperForce, isChunkCharted, isChunkVisible, isPositionVisible, requireKnownSurface } from "./fairness";
import { MAX_AREA_SIZE, boundedRegion } from "./queries";

const SCRATCH_SURFACE = "flh-scratch";

export const DIRECTIONS: Record<Direction, defines.direction> = {
  north: defines.direction.north,
  east: defines.direction.east,
  south: defines.direction.south,
  west: defines.direction.west,
};

/** One of a few script-owned item stacks for juggling blueprints. */
export function scratchStack(slot: 0 | 1 = 0): LuaItemStack {
  if (!storage.scratch || !storage.scratch.valid) storage.scratch = game.create_inventory(2);
  return storage.scratch[slot]!;
}

export function nextId(): number {
  storage.next_id = (storage.next_id ?? 0) + 1;
  return storage.next_id;
}

function forEachChunk(area: Area, fn: (chunk: { x: number; y: number }) => void): void {
  const lt = chunkOf(area.left_top);
  const rb = chunkOf({ x: area.right_bottom.x - 0.01, y: area.right_bottom.y - 0.01 });
  for (let x = lt.x; x <= rb.x; x++) for (let y = lt.y; y <= rb.y; y++) fn({ x, y });
}

export function requireCharted(surface: LuaSurface, area: Area): void {
  const force = helperForce();
  forEachChunk(area, (chunk) => {
    if (!isChunkCharted(force, surface, chunk)) throw "Part of that area has not been charted";
  });
}

export function requireVisible(surface: LuaSurface, area: Area): void {
  const force = helperForce();
  forEachChunk(area, (chunk) => {
    if (!isChunkVisible(force, surface, chunk)) throw "Part of that area is not currently visible (no radar coverage)";
  });
}

// ---- The library: chests full of blueprints/books, plus the requesting player's inventory ----

function libraryRoots(player?: LuaPlayer): { prefix: string; stacks: LuaItemStack[] }[] {
  const roots: { prefix: string; stacks: LuaItemStack[] }[] = [];
  storage.library = (storage.library ?? []).filter((chest) => chest.valid);
  storage.library.forEach((chest, index) => {
    const inventory = chest.get_inventory(defines.inventory.chest);
    if (!inventory) return;
    const stacks: LuaItemStack[] = [];
    for (let i = 0; i < inventory.length; i++) stacks.push(inventory[i]!);
    roots.push({ prefix: `c${index}`, stacks });
  });
  const main = player?.get_main_inventory();
  if (player && main) {
    const stacks: LuaItemStack[] = [];
    for (let i = 0; i < main.length; i++) stacks.push(main[i]!);
    roots.push({ prefix: `p${player.index}`, stacks });
  }
  return roots;
}

function walkLibrary(
  stacks: LuaItemStack[],
  prefix: string,
  book: string | undefined,
  visit: (id: string, stack: LuaItemStack, book: string | undefined) => void,
): void {
  stacks.forEach((stack, slot) => {
    if (!stack.valid_for_read) return;
    const id = `${prefix}/${slot}`;
    if (stack.is_blueprint && stack.is_blueprint_setup()) visit(id, stack, book);
    else if (stack.is_blueprint_book) {
      const inner = stack.get_inventory(defines.inventory.item_main);
      if (!inner) return;
      const children: LuaItemStack[] = [];
      for (let i = 0; i < inner.length; i++) children.push(inner[i]!);
      const label = stack.label ?? "book";
      walkLibrary(children, id, book ? `${book} / ${label}` : label, visit);
    }
  });
}

function summarizeBlueprint(stack: LuaItemStack): Omit<LibraryBlueprint, "id" | "book"> {
  const entities: Record<string, number> = {};
  const recipes: Record<string, number> = {};
  let minX = math.huge;
  let minY = math.huge;
  let maxX = -math.huge;
  let maxY = -math.huge;
  for (const e of stack.get_blueprint_entities() ?? []) {
    entities[e.name] = (entities[e.name] ?? 0) + 1;
    const recipe = (e as { recipe?: string }).recipe;
    if (recipe) recipes[recipe] = (recipes[recipe] ?? 0) + 1;
    minX = math.min(minX, e.position.x);
    minY = math.min(minY, e.position.y);
    maxX = math.max(maxX, e.position.x);
    maxY = math.max(maxY, e.position.y);
  }
  return {
    label: stack.label,
    description: stack.blueprint_description,
    size: minX === math.huge ? { width: 0, height: 0 } : { width: math.ceil(maxX - minX + 1), height: math.ceil(maxY - minY + 1) },
    entities,
    recipes,
  };
}

/** Blueprint entities listLibrary reads in total (~1.5 us each); the rest are listed without details. */
const MAX_LIBRARY_DETAIL_ENTITIES = 10000;

export function listLibrary(player?: LuaPlayer): LibraryBlueprint[] {
  const result: LibraryBlueprint[] = [];
  let budget = MAX_LIBRARY_DETAIL_ENTITIES;
  for (const root of libraryRoots(player)) {
    walkLibrary(root.stacks, root.prefix, undefined, (id, stack, book) => {
      const count = stack.get_blueprint_entity_count();
      if (count > budget || count > MAX_BUILD_ENTITIES) {
        result.push({
          id,
          book,
          label: stack.label,
          description: stack.blueprint_description,
          size: { width: 0, height: 0 },
          entities: {},
          recipes: {},
          entity_count: count,
          details_omitted: true,
        });
        return;
      }
      budget -= count;
      result.push({ id, book, entity_count: count, ...summarizeBlueprint(stack) });
    });
  }
  return result;
}

function findLibraryStack(id: string, player?: LuaPlayer): LuaItemStack {
  for (const root of libraryRoots(player)) {
    let found: LuaItemStack | undefined;
    walkLibrary(root.stacks, root.prefix, undefined, (candidate, stack) => {
      if (candidate === id) found = stack;
    });
    if (found) return found;
  }
  throw `No blueprint '${id}' in the library (list_blueprints shows what is available)`;
}

export function addLibraryChest(surfaceName: string, position: Position): number {
  const surface = requireKnownSurface(helperForce(), surfaceName);
  const chest = surface.find_entities_filtered({ position, radius: 0.5, type: ["container", "logistic-container"], limit: 1 })[0];
  if (!chest) throw "No chest at that position";
  if (chest.force !== helperForce()) throw "That chest belongs to another force";
  storage.library = (storage.library ?? []).filter((c) => c.valid && c !== chest);
  storage.library.push(chest);
  return storage.library.length;
}

// ---- Loading and filtering ----

/** Players can only build entities that have a regular (non-hidden) item to place them. */
function buildable(name: string): boolean {
  const items = prototypes.entity[name]?.items_to_place_this ?? [];
  return items.some((i) => prototypes.item[i.name] !== undefined && !prototypes.item[i.name]!.hidden);
}

/** Most entities one design may have: previewing costs ~25 us per entity, all in one tick. */
export const MAX_BUILD_ENTITIES = 1500;
const TOO_BIG = `Designs are limited to ${MAX_BUILD_ENTITIES} entities so previews don't stall the game; build it in parts`;

/** Loads a design into scratch slot 0 and removes unbuildable entities. */
export function loadSource(
  source: BlueprintSource,
  player?: LuaPlayer,
  label?: string,
): { stack: LuaItemStack; removed: Record<string, number>; entities: BlueprintEntity[] } {
  const stack = scratchStack(0);
  stack.clear();
  switch (source.kind) {
    case "string": {
      if (stack.import_stack(source.string) === 1) throw "Could not import that blueprint string";
      if (stack.is_blueprint_book) throw "That string is a blueprint book; import a single blueprint from it";
      break;
    }
    case "entities":
      stack.set_stack("blueprint");
      stack.set_blueprint_entities(source.entities as unknown as BlueprintEntityWrite[]);
      if (source.label) stack.label = source.label;
      break;
    case "library":
      stack.set_stack(findLibraryStack(source.id, player));
      break;
    case "copy": {
      const surface = requireKnownSurface(helperForce(), source.surface);
      const region = boundedRegion(source, "copy_area", { circle: false, overview: false });
      requireVisible(surface, source.area);
      const count = surface.count_entities_filtered({ ...region.filter, force: helperForce(), limit: MAX_BUILD_ENTITIES + 1 });
      if (count > MAX_BUILD_ENTITIES) throw `${TOO_BIG} (copy a smaller area)`;
      stack.set_stack("blueprint");
      stack.create_blueprint({
        surface,
        force: helperForce(),
        area: [source.area.left_top, source.area.right_bottom],
        include_modules: true,
        include_station_names: true,
      });
      break;
    }
  }
  if (!stack.valid_for_read || !stack.is_blueprint || !stack.is_blueprint_setup()) throw "That design has no entities";
  if (stack.get_blueprint_entity_count() > MAX_BUILD_ENTITIES) {
    const count = stack.get_blueprint_entity_count();
    stack.clear();
    throw `That design has ${count} entities. ${TOO_BIG}`;
  }
  if (label) stack.label = label;

  const removed: Record<string, number> = {};
  const entities = stack.get_blueprint_entities() ?? [];
  const kept = entities.filter((e) => {
    if (buildable(e.name)) return true;
    removed[e.name] = (removed[e.name] ?? 0) + 1;
    return false;
  });
  if (kept.length !== entities.length) {
    if (kept.length === 0) throw "Nothing in that design can be built by players";
    stack.set_blueprint_entities(kept as unknown as BlueprintEntityWrite[]);
  }
  return { stack, removed, entities: kept };
}

// ---- Dry run ----

export interface GhostInfo {
  name: string;
  position: Position;
  direction: number;
  box: Area;
}

function scratchSurface(): LuaSurface {
  let surface = game.get_surface(SCRATCH_SURFACE);
  if (!surface) {
    surface = game.create_surface(SCRATCH_SURFACE);
    surface.generate_with_lab_tiles = true;
    surface.always_day = true;
    for (const [, force] of game.forces) force.set_surface_hidden(surface, true);
  }
  return surface;
}

/**
 * Builds the blueprint on the hidden scratch surface at the origin and reports the ghosts'
 * exact positions and footprints, so previews match what build_blueprint will really do.
 */
export function dryRun(
  stack: LuaItemStack,
  direction: defines.direction,
  entities: BlueprintEntity[] = stack.get_blueprint_entities() ?? [],
): { ghosts: GhostInfo[]; bbox: Area } {
  const surface = scratchSurface();
  let extent = 8;
  for (const e of entities) extent = math.max(extent, math.abs(e.position.x), math.abs(e.position.y));
  // Bounds the scratch chunks generated (once) as well as the work below.
  if (extent > MAX_AREA_SIZE / 2) throw `That design is more than ${MAX_AREA_SIZE} tiles across; build it in parts`;
  surface.request_to_generate_chunks({ x: 0, y: 0 }, math.ceil(extent / 16) + 1);
  surface.force_generate_chunk_requests();

  const built = stack.build_blueprint({
    surface,
    force: helperForce(),
    position: { x: 0, y: 0 },
    direction,
    build_mode: defines.build_mode.forced,
    raise_built: false,
  });
  const ghosts: GhostInfo[] = [];
  const bbox = { left_top: { x: math.huge, y: math.huge }, right_bottom: { x: -math.huge, y: -math.huge } };
  for (const ghost of built) {
    if (ghost.valid && ghost.type === "entity-ghost") {
      const box = ghost.bounding_box;
      ghosts.push({
        name: ghost.ghost_name,
        position: { x: ghost.position.x, y: ghost.position.y },
        direction: ghost.direction,
        box: { left_top: { x: box.left_top.x, y: box.left_top.y }, right_bottom: { x: box.right_bottom.x, y: box.right_bottom.y } },
      });
      bbox.left_top.x = math.min(bbox.left_top.x, math.floor(box.left_top.x));
      bbox.left_top.y = math.min(bbox.left_top.y, math.floor(box.left_top.y));
      bbox.right_bottom.x = math.max(bbox.right_bottom.x, math.ceil(box.right_bottom.x));
      bbox.right_bottom.y = math.max(bbox.right_bottom.y, math.ceil(box.right_bottom.y));
    }
    if (ghost.valid) ghost.destroy();
  }
  if (ghosts.length === 0) throw "That design produced no buildable ghosts";
  return { ghosts, bbox };
}
