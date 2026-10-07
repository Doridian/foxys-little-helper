// Factory index: per-chunk summaries of the helper force's entities (see ChunkSummary in the
// protocol), kept up to date from build/removal events plus an amortised background rescan, so
// the bridge can mirror a megabase through index_changes instead of scanning the world.
//
// - Events only mark chunks dirty; summarising happens in on_tick within a budget of K chunks
//   per tick (setting flh-index-chunks-per-tick; dense chunks count as several, see
//   COST_PER_CHUNK): dirty chunks first, then first-run discovery, then round-robin over every
//   chunk with our entities, which refreshes statuses and catches recipe changes (no event).
// - Fairness: only charted chunks are indexed; statuses only when the chunk is visible.
// - Each written summary gets a new global revision. Chunks form a doubly linked list ordered by
//   revision (rewritten chunks move to the tail), so index_changes walks only what changed.
//   Chunks that lose all our entities stay as tombstones (no summary) so mirrors learn about it.
// - Summaries are stored as canonical JSON strings: compact in the save, "unchanged" is a string
//   comparison (rescans that find nothing new don't bump the revision), and index_changes
//   splices them into its reply without decoding.

import { ChunkSummary, RpcMethods } from "@flh/protocol";
import { LuaEntity, LuaForce, LuaSurface, SurfaceIndex } from "factorio:runtime";
import { helperForce, isChunkCharted, isChunkVisible } from "./fairness";
import { rawJson } from "./raw-json";

type Params<M extends keyof RpcMethods> = RpcMethods[M]["params"];
type Result<M extends keyof RpcMethods> = RpcMethods[M]["result"];

const SETTING = "flh-index-chunks-per-tick";
const SCRATCH_SURFACE = "flh-scratch";
const DEFAULT_CHANGES_LIMIT = 500;
const MAX_CHANGES_LIMIT = 5000;
const DEFAULT_CHUNKS_PER_TICK = 3;
/**
 * The budget is in chunks of typical cost (~0.1 ms). summarise() estimates what a chunk really
 * cost from what it read (calibrated by profiling the background pass, GC included), so a dense
 * chunk uses up several "chunks" of budget and a sparse one a fraction.
 */
const COST_PER_CHUNK = 100;
/** One count_entities_filtered (empty chunk, discovery, uncharted check), µs. */
const COST_CHECK = 10;
/** Round-robin steps over tombstones per tick (they cost a table lookup each, not a summary). */
const MAX_SKIPS_PER_TICK = 2000;

// Chunk keys: chunk coordinates are within +-31250 on the largest maps, so (x, y) packs into 32
// bits and the surface index goes above that (exact in a double up to 2^53).
const OFFSET = 32768;
const SPAN = 65536;
const SURFACE_MUL = SPAN * SPAN;

function localKey(x: number, y: number): number {
  return (x + OFFSET) * SPAN + (y + OFFSET);
}
function globalKey(surfaceIndex: number, local: number): number {
  return surfaceIndex * SURFACE_MUL + local;
}
function splitKey(key: number): LuaMultiReturn<[number, number, number]> {
  const surfaceIndex = math.floor(key / SURFACE_MUL);
  const local = key % SURFACE_MUL;
  return $multi(surfaceIndex, math.floor(local / SPAN) - OFFSET, (local % SPAN) - OFFSET);
}

// ---- Storage ----

/** Bump when the stored layout changes: the index is then rebuilt on the next configuration change. */
const INDEX_VERSION = 1;

function index(): FlhIndex {
  if (!storage.index) {
    storage.index = {
      version: INDEX_VERSION,
      revision: 0,
      surfaces: new LuaMap(),
      by_revision: new LuaMap(),
      dirty: new LuaMap(),
      queue: new LuaMap(),
      queue_first: 1,
      queue_last: 0,
      uncharted: new LuaMap(),
      seed: [],
      seed_pos: 1,
      budget: 0,
    };
  }
  return storage.index!;
}

function surfaceState(idx: FlhIndex, surface: LuaSurface): FlhIndexSurface {
  let state = idx.surfaces.get(surface.index);
  if (!state) {
    state = { name: surface.name, chunks: new LuaMap(), live: 0, pending: 0 };
    idx.surfaces.set(surface.index, state);
  } else if (state.deleted) {
    // Surface index reused by a new surface: its old chunks are all tombstones already.
    state.deleted = undefined;
    state.name = surface.name;
  }
  return state;
}

function entryOf(idx: FlhIndex, key: number): FlhIndexChunk | undefined {
  const [surfaceIndex] = splitKey(key);
  return idx.surfaces.get(surfaceIndex)?.chunks.get(key % SURFACE_MUL);
}

function unlink(idx: FlhIndex, entry: FlhIndexChunk): void {
  if (entry.r === undefined) return;
  idx.by_revision.delete(entry.r);
  if (entry.p !== undefined) entryOf(idx, entry.p)!.n = entry.n;
  else idx.head = entry.n;
  if (entry.n !== undefined) entryOf(idx, entry.n)!.p = entry.p;
  else idx.tail = entry.p;
  entry.p = undefined;
  entry.n = undefined;
}

/** Stores a chunk's new summary (undefined = nothing of ours there) under a new revision, if it changed. */
function write(idx: FlhIndex, state: FlhIndexSurface, surfaceIndex: number, local: number, json: string | undefined): void {
  let entry = state.chunks.get(local);
  if (!entry) {
    if (json === undefined) return;
    entry = {};
    state.chunks.set(local, entry);
  } else if (entry.j === json) {
    return;
  }
  if (entry.j === undefined) state.live++;
  if (json === undefined) state.live--;
  unlink(idx, entry);
  const key = globalKey(surfaceIndex, local);
  idx.revision++;
  entry.r = idx.revision;
  entry.t = game.tick;
  entry.j = json;
  entry.p = idx.tail;
  if (idx.tail !== undefined) entryOf(idx, idx.tail)!.n = key;
  else idx.head = key;
  idx.tail = key;
  idx.by_revision.set(idx.revision, key);
}

// ---- Summarising one chunk ----

const enum Kind {
  Skip,
  Crafter,
  Miner,
  Lab,
  TrainStop,
  Ghost,
  Other,
}

/** Entity searches reject unknown type names; keep only the types this game version has. */
function knownTypes(types: string[]): string[] {
  const all = defines.prototypes.entity as unknown as Record<string, unknown>;
  return types.filter((type) => all[type] !== undefined);
}

/** Things that move or are transient: indexing them would churn every pass and go stale between. */
const MOBILE_TYPES = knownTypes([
  "character", "car", "spider-vehicle", "spider-leg", "spider-unit", "locomotive", "cargo-wagon", "fluid-wagon",
  "artillery-wagon", "infinity-cargo-wagon", "construction-robot", "logistic-robot", "combat-robot", "capture-robot",
  "unit", "segmented-unit", "segment", "projectile", "artillery-projectile", "item-request-proxy",
  "deconstructible-tile-proxy", "cargo-pod", "highlight-box", "arrow", "explosion", "fire", "stream", "sticker",
  "beam", "smoke-with-trigger", "speech-bubble", "rocket-silo-rocket", "rocket-silo-rocket-shadow", "corpse",
  "character-corpse", "particle-source", "asteroid", "temporary-container",
]);
const KIND_BY_TYPE: Record<string, Kind> = {
  "assembling-machine": Kind.Crafter,
  furnace: Kind.Crafter,
  "rocket-silo": Kind.Crafter,
  "mining-drill": Kind.Miner,
  lab: Kind.Lab,
  "train-stop": Kind.TrainStop,
  "entity-ghost": Kind.Ghost,
  "tile-ghost": Kind.Ghost,
};
/** Types we read entity by entity. */
const SPECIAL_TYPES = knownTypes(Object.keys(KIND_BY_TYPE));
const NOT_OTHER_TYPES = [...SPECIAL_TYPES, ...MOBILE_TYPES];
const MOBILE_SET = new LuaSet<string>();
for (const type of MOBILE_TYPES) MOBILE_SET.add(type);

/**
 * Names with at least this many in a chunk are counted with count_entities_filtered next time
 * (one ~10 µs call) instead of reading each entity (~0.4 µs each just to get a handle).
 */
const BULK_MIN = 32;

// Per prototype name (not saved; rebuilt lazily after load, so deterministic).
const kinds = new LuaMap<string, Kind>();
/** Entities whose bounding box may reach into a neighbouring chunk: count them by position only. */
const straddles = new LuaMap<string, boolean>();

function kindOf(name: string): Kind {
  let kind = kinds.get(name);
  if (kind === undefined) {
    const proto = prototypes.entity[name];
    const type = proto?.type ?? "";
    kind = MOBILE_SET.has(type) ? Kind.Skip : (KIND_BY_TYPE[type] ?? Kind.Other);
    const box = proto?.collision_box;
    straddles.set(
      name,
      kind === Kind.Ghost ||
        !box ||
        box.left_top.x <= -0.5 ||
        box.left_top.y <= -0.5 ||
        box.right_bottom.x >= 0.5 ||
        box.right_bottom.y >= 0.5,
    );
    kinds.set(name, kind);
  }
  return kind;
}

let statusNames: LuaMap<number, string> | undefined;
function statusName(status: defines.entity_status | undefined): string {
  if (status === undefined) return "none";
  if (!statusNames) {
    statusNames = new LuaMap();
    for (const [name, value] of pairs(defines.entity_status as unknown as LuaTable<string, number>)) {
      statusNames.set(value, name);
    }
  }
  return statusNames.get(status as unknown as number) ?? tostring(status);
}

/** machine -> key (recipe or resource) -> { count, statuses } */
type Groups = LuaMap<string, LuaMap<string, { count: number; statuses?: LuaMap<string, number> }>>;

function addTo(groups: Groups, machine: string, key: string, status: string | undefined): void {
  let byKey = groups.get(machine);
  if (!byKey) {
    byKey = new LuaMap();
    groups.set(machine, byKey);
  }
  let group = byKey.get(key);
  if (!group) {
    group = { count: 0, statuses: status !== undefined ? new LuaMap() : undefined };
    byKey.set(key, group);
  }
  group.count++;
  if (status !== undefined) group.statuses!.set(status, (group.statuses!.get(status) ?? 0) + 1);
}

function addCount(map: LuaMap<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1);
}

function sortedKeys<V>(map: LuaMap<string, V>): string[] {
  const keys: string[] = [];
  for (const [key] of map) keys.push(key);
  table.sort(keys);
  return keys;
}

/** Plain object with keys inserted in sorted order, so equal content encodes to equal JSON. */
function sortedObject(map: LuaMap<string, number>): Record<string, number> | undefined {
  let result: Record<string, number> | undefined;
  for (const key of sortedKeys(map)) {
    result ??= {};
    result[key] = map.get(key)!;
  }
  return result;
}

function groupRows<K extends "recipe" | "resource">(groups: Groups, field: K) {
  const rows: ({ machine: string; count: number; statuses?: Record<string, number> } & Record<K, string>)[] = [];
  for (const machine of sortedKeys(groups)) {
    const byKey = groups.get(machine)!;
    for (const key of sortedKeys(byKey)) {
      const group = byKey.get(key)!;
      rows.push({
        [field]: key,
        machine,
        count: group.count,
        statuses: group.statuses && sortedObject(group.statuses),
      } as never);
    }
  }
  return rows.length > 0 ? rows : undefined;
}

/** Stored form of a summary: ChunkSummary without the per-write fields (index_changes splices those in). */
type StoredSummary = Omit<ChunkSummary, "surface" | "x" | "y" | "revision" | "tick">;

/**
 * Summarises our entities in one charted chunk as canonical JSON (undefined if there are none),
 * plus the names to count in bulk next time and the estimated cost in µs. Each entity counts in
 * the chunk holding its position. Special types (crafters, miners...) are read one by one; plain
 * entities whose name was common here last time (`bulk`) are just counted, and the rest are
 * read. `others` = every other force, used to select our force in inverted searches.
 */
function summarise(
  force: LuaForce,
  others: LuaForce[],
  surface: LuaSurface,
  x: number,
  y: number,
  bulk: string[] | undefined,
): LuaMultiReturn<[string | undefined, string[] | undefined, number]> {
  const visible = isChunkVisible(force, surface, { x, y });
  const left = x * 32;
  const top = y * 32;
  const area: [[number, number], [number, number]] = [
    [left, top],
    [left + 32, top + 32],
  ];

  const crafters: Groups = new LuaMap();
  const miners: Groups = new LuaMap();
  const entities = new LuaMap<string, number>();
  const ghosts = new LuaMap<string, number>();
  let stops: string[] | undefined;
  let labs = 0;
  let any = false;

  const special = surface.find_entities_filtered({ area, force, type: SPECIAL_TYPES });
  for (const entity of special) {
    const name = entity.name;
    const kind = kindOf(name);
    if (straddles.get(name)) {
      const position = entity.position;
      if (position.x < left || position.x >= left + 32 || position.y < top || position.y >= top + 32) continue;
    }
    any = true;
    switch (kind) {
      case Kind.Crafter: {
        const recipe = recipeName(entity);
        if (recipe === undefined) addCount(entities, name);
        else addTo(crafters, name, recipe, visible ? statusName(entity.status) : undefined);
        break;
      }
      case Kind.Miner:
        addTo(miners, name, minedResource(surface, entity), visible ? statusName(entity.status) : undefined);
        break;
      case Kind.Lab:
        labs++;
        break;
      case Kind.TrainStop:
        addCount(entities, name);
        (stops ??= []).push(entity.backer_name ?? "");
        break;
      case Kind.Ghost:
        addCount(ghosts, entity.ghost_name);
        break;
    }
  }

  if (bulk) {
    for (const name of bulk) {
      const count = surface.count_entities_filtered({ area, force, name });
      if (count > 0) {
        entities.set(name, count);
        any = true;
      }
    }
  }
  // Inverted filters: not another force, not special or mobile, not counted above.
  const rest = surface.find_entities_filtered({
    area,
    force: others,
    type: NOT_OTHER_TYPES,
    name: bulk && bulk.length > 0 ? bulk : undefined,
    invert: true,
  });
  for (const entity of rest) {
    const name = entity.name;
    if (kindOf(name) === Kind.Skip) continue;
    if (straddles.get(name)) {
      const position = entity.position;
      if (position.x < left || position.x >= left + 32 || position.y < top || position.y >= top + 32) continue;
    }
    any = true;
    addCount(entities, name);
  }
  const cost = 35 + 4.2 * special.length + 1.7 * rest.length + 14 * (bulk?.length ?? 0);
  if (!any) return $multi(undefined, undefined, cost);

  let nextBulk: string[] | undefined;
  for (const [name, count] of entities) {
    if (count >= BULK_MIN && kindOf(name) === Kind.Other && !straddles.get(name)) (nextBulk ??= []).push(name);
  }
  if (nextBulk) table.sort(nextBulk);
  if (stops) table.sort(stops);
  const stored: StoredSummary = {
    visible,
    crafters: groupRows(crafters, "recipe") ?? [],
    miners: groupRows(miners, "resource") ?? [],
    labs,
    entities: sortedObject(entities) ?? {},
    train_stops: stops,
    ghosts: sortedObject(ghosts),
  };
  // Stored without the opening brace, ready to be spliced after the per-write fields.
  return $multi(helpers.table_to_json(stored).slice(1), nextBulk, cost);
}

/** What a drill mines; drills that never ran (no power yet) have no target, so look underneath. "" = depleted. */
function minedResource(surface: LuaSurface, drill: LuaEntity): string {
  const target = drill.mining_target;
  if (target) return target.name;
  const resource = surface.find_entities_filtered({ area: drill.mining_area, type: "resource", limit: 1 })[0];
  return resource?.name ?? "";
}

function recipeName(entity: LuaEntity): string | undefined {
  const [recipe] = entity.get_recipe();
  if (recipe) return recipe.name;
  if (entity.type === "furnace") return entity.previous_recipe?.name.name;
  return undefined;
}

// ---- Dirty queue and background pass ----

function markDirtyKey(idx: FlhIndex, surface: LuaSurface, local: number): void {
  if (surface.name === SCRATCH_SURFACE) return;
  const key = globalKey(surface.index, local);
  if (idx.dirty.has(key)) return;
  idx.dirty.set(key, true);
  surfaceState(idx, surface).pending++;
  idx.queue_last++;
  idx.queue.set(idx.queue_last, key);
}

/** Marks an entity's chunk for re-summarising (other forces are ignored). */
export function markEntityDirty(entity: LuaEntity | undefined): void {
  if (!entity || !entity.valid || entity.force_index !== helperForce().index) return;
  const position = entity.position;
  markDirtyKey(index(), entity.surface, localKey(math.floor(position.x / 32), math.floor(position.y / 32)));
}

function hasOurs(force: LuaForce, surface: LuaSurface, x: number, y: number): boolean {
  return surface.count_entities_filtered({ area: [[x * 32, y * 32], [x * 32 + 32, y * 32 + 32]], force, limit: 1 }) > 0;
}

function otherForces(force: LuaForce): LuaForce[] {
  const others: LuaForce[] = [];
  for (const [, other] of game.forces) if (other !== force) others.push(other);
  return others;
}

/** Re-summarises one chunk and stores the result; returns the estimated cost in µs. */
function refresh(idx: FlhIndex, force: LuaForce, others: LuaForce[], surface: LuaSurface, local: number): number {
  const x = math.floor(local / SPAN) - OFFSET;
  const y = (local % SPAN) - OFFSET;
  const state = surfaceState(idx, surface);
  let json: string | undefined;
  let bulk: string[] | undefined;
  let cost = COST_CHECK;
  if (isChunkCharted(force, surface, { x, y })) {
    [json, bulk, cost] = summarise(force, others, surface, x, y, state.chunks.get(local)?.b);
  } else if (hasOurs(force, surface, x, y)) {
    // Ours but not charted (built in the dark): index it once on_chunk_charted says so.
    idx.uncharted.set(globalKey(surface.index, local), true);
  }
  write(idx, state, surface.index, local, json);
  const entry = state.chunks.get(local);
  if (entry) entry.b = bulk;
  return cost;
}

function chunksPerTick(): number {
  return (settings.global[SETTING]?.value as number | undefined) ?? DEFAULT_CHUNKS_PER_TICK;
}

/** Moves the round-robin cursor to the next surface; undefined after the last one (wraps next tick). */
function nextSurface(idx: FlhIndex): void {
  const [surfaceIndex] = next(idx.surfaces as unknown as LuaTable<number, FlhIndexSurface>, idx.rr_surface);
  idx.rr_surface = surfaceIndex;
  idx.rr_chunk = undefined;
  if (surfaceIndex !== undefined) idx.surfaces.get(surfaceIndex)!.pass_start = game.tick;
}

/** Re-summarises chunks that have summaries, surface by surface, while there is budget. */
function roundRobinStep(idx: FlhIndex, force: LuaForce, others: LuaForce[]): void {
  if (idx.rr_surface === undefined) nextSurface(idx);
  let skips = 0;
  while (idx.budget > 0 && skips < MAX_SKIPS_PER_TICK && idx.rr_surface !== undefined) {
    const state = idx.surfaces.get(idx.rr_surface)!;
    const surface = state.deleted ? undefined : game.get_surface(idx.rr_surface as SurfaceIndex);
    if (!surface || !surface.valid) {
      nextSurface(idx);
      skips++;
      continue;
    }
    const [local, entry] = next(state.chunks as unknown as LuaTable<number, FlhIndexChunk>, idx.rr_chunk);
    if (local === undefined) {
      state.last_full_pass = state.pass_start;
      nextSurface(idx);
      skips++;
      continue;
    }
    idx.rr_chunk = local;
    if (entry.j === undefined) {
      skips++; // tombstone
      continue;
    }
    idx.budget -= refresh(idx, force, others, surface, local) / COST_PER_CHUNK;
  }
}

function onTick(): void {
  const idx = storage.index;
  if (!idx || idx.version !== INDEX_VERSION) return;
  const k = chunksPerTick();
  if (k <= 0) return;
  // Unused budget doesn't carry over, debt from an expensive chunk does.
  idx.budget = math.min(idx.budget, 0) + k;
  if (idx.budget <= 0) return;
  const force = helperForce();
  const others = otherForces(force);

  // 1. Chunks marked dirty by events.
  while (idx.budget > 0 && idx.queue_first <= idx.queue_last) {
    const key = idx.queue.get(idx.queue_first)!;
    idx.queue.delete(idx.queue_first);
    idx.queue_first++;
    idx.dirty.delete(key);
    const [surfaceIndex] = splitKey(key);
    const state = idx.surfaces.get(surfaceIndex);
    if (state) state.pending--;
    const surface = game.get_surface(surfaceIndex as SurfaceIndex);
    if (!surface || !surface.valid || !state || state.deleted) continue;
    idx.budget -= refresh(idx, force, others, surface, key % SURFACE_MUL) / COST_PER_CHUNK;
  }

  // 2. First-run discovery: cheap "anything of ours here?" checks.
  while (idx.budget > 0 && idx.seed_pos <= idx.seed.length) {
    const key = idx.seed[idx.seed_pos - 1];
    idx.seed_pos++;
    idx.budget -= COST_CHECK / COST_PER_CHUNK;
    const [surfaceIndex, x, y] = splitKey(key);
    const surface = game.get_surface(surfaceIndex as SurfaceIndex);
    if (!surface || !surface.valid || !hasOurs(force, surface, x, y)) continue;
    if (isChunkCharted(force, surface, { x, y })) markDirtyKey(idx, surface, key % SURFACE_MUL);
    else idx.uncharted.set(key, true);
  }
  if (idx.seed.length > 0 && idx.seed_pos > idx.seed.length) {
    idx.seed = [];
    idx.seed_pos = 1;
  }

  // 3. Round-robin refresh of everything indexed (statuses, recipe changes, missed events).
  if (idx.budget > 0) roundRobinStep(idx, force, others);
}

// ---- Lifecycle and events ----

/**
 * Queues every generated chunk for discovery: for existing saves, and after mod changes (entities
 * may vanish without events). Enumerating is cheap (~2 µs per chunk) and runs at load time; the
 * checks themselves are spread over ticks.
 */
function seedAll(): void {
  const idx = index();
  idx.seed = [];
  idx.seed_pos = 1;
  for (const [, surface] of game.surfaces) {
    if (surface.name === SCRATCH_SURFACE) continue;
    for (const chunk of surface.get_chunks()) idx.seed.push(globalKey(surface.index, localKey(chunk.x, chunk.y)));
  }
}

/** Turns every chunk of a surface into a tombstone (surface deleted or cleared). */
function dropSurface(surfaceIndex: number, deleted: boolean): void {
  const idx = storage.index;
  const state = idx?.surfaces.get(surfaceIndex);
  if (!idx || !state) return;
  for (const [local, entry] of state.chunks) {
    if (entry.j !== undefined) write(idx, state, surfaceIndex, local, undefined);
  }
  if (deleted) {
    state.deleted = true;
    for (const [key] of idx.uncharted) {
      if (math.floor(key / SURFACE_MUL) === surfaceIndex) idx.uncharted.delete(key);
    }
  }
}

function onBuilt(event: { entity: LuaEntity }): void {
  markEntityDirty(event.entity);
}

export function registerIndex(): void {
  script.on_init(() => {
    index();
    seedAll();
  });
  script.on_configuration_changed(() => {
    const old = storage.index;
    if (old && old.version !== INDEX_VERSION) {
      // Rebuild, keeping revisions increasing so mirrors pick up every rewritten chunk.
      // (Chunks that emptied meanwhile get no tombstone; a mirror resyncing from 0 is exact.)
      storage.index = undefined;
      index().revision = old.revision;
    }
    index();
    seedAll();
  });
  script.on_event(defines.events.on_tick, onTick);

  script.on_event(defines.events.on_built_entity, onBuilt);
  script.on_event(defines.events.on_robot_built_entity, onBuilt);
  script.on_event(defines.events.on_space_platform_built_entity, onBuilt);
  script.on_event(defines.events.script_raised_built, onBuilt);
  script.on_event(defines.events.script_raised_revive, onBuilt);
  script.on_event(defines.events.on_player_mined_entity, onBuilt);
  script.on_event(defines.events.on_robot_mined_entity, onBuilt);
  script.on_event(defines.events.on_space_platform_mined_entity, onBuilt);
  script.on_event(defines.events.on_entity_died, onBuilt);
  script.on_event(defines.events.script_raised_destroy, onBuilt);
  script.on_event(defines.events.script_raised_teleported, onBuilt);
  script.on_event(defines.events.on_entity_cloned, (event) => markEntityDirty(event.destination));
  // Recipe pastes don't raise build events.
  script.on_event(defines.events.on_entity_settings_pasted, (event) => markEntityDirty(event.destination));

  script.on_event(defines.events.on_chunk_charted, (event) => {
    if (event.force.index !== helperForce().index) return;
    const idx = storage.index;
    if (!idx) return;
    const local = localKey(event.position.x, event.position.y);
    const key = globalKey(event.surface_index, local);
    // Radars re-chart constantly; only chunks known to hold our entities need a look.
    if (!idx.uncharted.has(key)) return;
    idx.uncharted.delete(key);
    markDirtyKey(idx, game.get_surface(event.surface_index)!, local);
  });
  script.on_event(defines.events.on_chunk_deleted, (event) => {
    const idx = storage.index;
    const state = idx?.surfaces.get(event.surface_index);
    if (!idx || !state) return;
    for (const position of event.positions) {
      const local = localKey(position.x, position.y);
      idx.uncharted.delete(globalKey(event.surface_index, local));
      write(idx, state, event.surface_index, local, undefined);
    }
  });
  script.on_event(defines.events.on_surface_cleared, (event) => dropSurface(event.surface_index, false));
  script.on_event(defines.events.on_surface_deleted, (event) => dropSurface(event.surface_index, true));
  script.on_event(defines.events.on_forces_merged, () => seedAll());
}

// ---- RPC ----

export function indexStatus(): Result<"index_status"> {
  const idx = index();
  const surfaces: Result<"index_status">["surfaces"] = [];
  for (const [, state] of idx.surfaces) {
    if (state.deleted) continue;
    surfaces.push({ name: state.name, chunks: state.live, pending: state.pending, last_full_pass_tick: state.last_full_pass });
  }
  return { revision: idx.revision, surfaces };
}

function firstAfter(idx: FlhIndex, since: number): number | undefined {
  if (since <= 0 || idx.head === undefined || entryOf(idx, idx.head)!.r! > since) return idx.head;
  // Fast path: the chunk the caller saw last hasn't been rewritten since.
  const known = idx.by_revision.get(since);
  if (known !== undefined) return entryOf(idx, known)!.n;
  // Otherwise walk back from the tail over everything newer (which the caller needs anyway).
  let key = idx.tail;
  let first: number | undefined;
  while (key !== undefined) {
    const entry = entryOf(idx, key)!;
    if (entry.r! <= since) break;
    first = key;
    key = entry.p;
  }
  return first;
}

export function indexChanges(params: Params<"index_changes">): Result<"index_changes"> {
  const idx = index();
  const limit = math.max(1, math.min(params.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT));
  // Built as JSON text: each chunk is its per-write fields spliced in front of the stored
  // summary (500 chunks: ~2 ms instead of ~11 ms for decoding and re-encoding them).
  const chunks: string[] = [];
  const removed: string[] = [];
  const surfaceNames = new LuaMap<number, string>();
  let key = firstAfter(idx, params.since ?? 0);
  let last = params.since ?? 0;
  let count = 0;
  while (key !== undefined && count < limit) {
    const entry = entryOf(idx, key)!;
    const [surfaceIndex, x, y] = splitKey(key);
    let surface = surfaceNames.get(surfaceIndex);
    if (surface === undefined) {
      surface = helpers.table_to_json([idx.surfaces.get(surfaceIndex)!.name]).slice(1, -1);
      surfaceNames.set(surfaceIndex, surface);
    }
    // string.format: much faster than tostring() for numbers in Factorio's Lua.
    if (entry.j !== undefined) {
      if (chunks.length > 0) chunks.push(",");
      chunks.push(string.format('{"surface":%s,"x":%d,"y":%d,"revision":%d,"tick":%d,', surface, x, y, entry.r!, entry.t!));
      chunks.push(entry.j);
    } else {
      if (removed.length > 0) removed.push(",");
      removed.push(string.format('{"surface":%s,"x":%d,"y":%d,"revision":%d}', surface, x, y, entry.r!));
    }
    last = entry.r!;
    count++;
    key = entry.n;
  }
  const more = key !== undefined;
  const revision = more ? last : idx.revision;
  return rawJson(
    string.format('{"revision":%d,"chunks":[%s],"removed":[%s],"more":%s}', revision, table.concat(chunks), table.concat(removed), tostring(more)),
  );
}
