// Fairness rules: the helper only knows what a player of its force could know through
// remote view. Every query in queries.ts must go through these checks.
//
// - Charted chunks: a player can see the map there, but not live details.
// - Visible chunks (radar coverage or a player/vehicle nearby): live details are fine.

import { Position } from "@flh/protocol";
import { ChunkPosition, LuaForce, LuaSurface } from "factorio:runtime";

const CHUNK_SIZE = 32;

export function chunkOf(position: Position): ChunkPosition {
  return { x: math.floor(position.x / CHUNK_SIZE), y: math.floor(position.y / CHUNK_SIZE) };
}

export function isPositionVisible(force: LuaForce, surface: LuaSurface, position: Position): boolean {
  return force.is_chunk_visible(surface, chunkOf(position));
}

export function isPositionCharted(force: LuaForce, surface: LuaSurface, position: Position): boolean {
  return force.is_chunk_charted(surface, chunkOf(position));
}

/** Throws unless the surface exists and the force has charted at least something on it. */
export function requireKnownSurface(force: LuaForce, surfaceName: string): LuaSurface {
  const surface = game.get_surface(surfaceName);
  if (!surface) throw `Unknown surface '${surfaceName}'`;
  for (const _chunk of surface.get_chunks()) {
    if (force.is_chunk_charted(surface, _chunk)) return surface;
  }
  throw `Surface '${surfaceName}' has not been charted by force '${force.name}'`;
}

/** The force the helper plays as. Single-force for now. */
export function helperForce(): LuaForce {
  return game.forces["player"]!;
}
