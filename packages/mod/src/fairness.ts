// Fairness rules: the helper only knows what a player of its force could know through
// remote view. Every query in queries.ts must go through these checks.
//
// - Charted chunks: a player can see the map there, but not live details.
// - Visible chunks (radar coverage or a player/vehicle nearby): live details are fine.

import { Area, Position } from "@flh/protocol";
import { ChunkPosition, LuaForce, LuaSurface } from "factorio:runtime";

const CHUNK_SIZE = 32;

/**
 * Test-only: the separate `flh-dev` mod (scripts/dev-mods, loaded only by dev-server.sh with
 * FLH_DEV_FOG_OFF=1, never shipped) lifts fog of war so automated tests on freshly generated
 * worlds work; servers only chart while a player is connected.
 */
const FOG_OFF = script.active_mods["flh-dev"] !== undefined;

/** Every charted/visible check in the mod goes through these two. */
export function isChunkCharted(force: LuaForce, surface: LuaSurface, chunk: ChunkPosition): boolean {
  return FOG_OFF || force.is_chunk_charted(surface, chunk);
}

export function isChunkVisible(force: LuaForce, surface: LuaSurface, chunk: ChunkPosition): boolean {
  return FOG_OFF || force.is_chunk_visible(surface, chunk);
}

export function chunkOf(position: Position): ChunkPosition {
  return { x: math.floor(position.x / CHUNK_SIZE), y: math.floor(position.y / CHUNK_SIZE) };
}

export function isPositionVisible(force: LuaForce, surface: LuaSurface, position: Position): boolean {
  return isChunkVisible(force, surface, chunkOf(position));
}

export function isPositionCharted(force: LuaForce, surface: LuaSurface, position: Position): boolean {
  return isChunkCharted(force, surface, chunkOf(position));
}

/** A number identifying the chunk a position is in, for LuaSet lookups (|chunk y| < 2^20). */
export function chunkKey(position: Position): number {
  const chunk = chunkOf(position);
  return chunk.x * 2097152 + chunk.y;
}

/**
 * chunkKey()s of the chunks overlapping `area` that the force can't currently see, or undefined
 * when it sees all of them (the common case, so callers can skip per-entity checks). Callers
 * bound the area, so this is a bounded number of chunk checks.
 */
export function hiddenChunksIn(force: LuaForce, surface: LuaSurface, area: Area): LuaSet<number> | undefined {
  const lt = chunkOf(area.left_top);
  const rb = chunkOf({ x: area.right_bottom.x - 0.01, y: area.right_bottom.y - 0.01 });
  let hidden: LuaSet<number> | undefined;
  for (let x = lt.x; x <= rb.x; x++) {
    for (let y = lt.y; y <= rb.y; y++) {
      if (isChunkVisible(force, surface, { x, y })) continue;
      hidden ??= new LuaSet();
      hidden.add(chunkKey({ x: x * CHUNK_SIZE, y: y * CHUNK_SIZE }));
    }
  }
  return hidden;
}

/** How many chunks requireKnownSurface looks at before giving up (~1 us each). */
const MAX_SURFACE_CHUNK_SCAN = 10000;

/** Throws unless the surface exists and the force has charted at least something on it. */
export function requireKnownSurface(force: LuaForce, surfaceName: string): LuaSurface {
  const surface = game.get_surface(surfaceName);
  if (!surface) throw `Unknown surface '${surfaceName}'`;
  // The chunk at the origin (spawn, landing site) is nearly always charted: skip the scan.
  if (surface.is_chunk_generated({ x: 0, y: 0 }) && isChunkCharted(force, surface, { x: 0, y: 0 })) return surface;
  let scanned = 0;
  for (const chunk of surface.get_chunks()) {
    if (isChunkCharted(force, surface, chunk)) return surface;
    if (++scanned >= MAX_SURFACE_CHUNK_SCAN) break;
  }
  throw `Surface '${surfaceName}' has not been charted by force '${force.name}'`;
}

/** The force the helper plays as. Single-force for now. */
export function helperForce(): LuaForce {
  return game.forces["player"]!;
}
