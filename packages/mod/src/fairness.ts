// Fairness rules: the helper only knows what a player of its force could know through
// remote view. Every query in queries.ts must go through these checks.
//
// - Charted chunks: a player can see the map there, but not live details.
// - Visible chunks (radar coverage or a player/vehicle nearby): live details are fine.

import { Position } from "@flh/protocol";
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

/** Throws unless the surface exists and the force has charted at least something on it. */
export function requireKnownSurface(force: LuaForce, surfaceName: string): LuaSurface {
  const surface = game.get_surface(surfaceName);
  if (!surface) throw `Unknown surface '${surfaceName}'`;
  for (const _chunk of surface.get_chunks()) {
    if (isChunkCharted(force, surface, _chunk)) return surface;
  }
  throw `Surface '${surfaceName}' has not been charted by force '${force.name}'`;
}

/** The force the helper plays as. Single-force for now. */
export function helperForce(): LuaForce {
  return game.forces["player"]!;
}
