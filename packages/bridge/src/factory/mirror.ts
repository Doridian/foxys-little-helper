// Local copy of the mod's factory index: per-chunk summaries pulled incrementally with
// index_changes. Pure data structure; FactoryIndex (service.ts) does the RPC.

import type { ChunkSummary, RpcMethods } from "@flh/protocol";

export type IndexPage = RpcMethods["index_changes"]["result"];

/** Chunk coordinates as one number (|x|, |y| < 2^15 covers the whole 2M-tile map). */
export const chunkKey = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);
export const keyX = (key: number) => Math.floor(key / 65536) - 32768;
export const keyY = (key: number) => (key % 65536) - 32768;

export class IndexMirror {
  /** Revision to pass as `since` next time. */
  revision = 0;
  readonly surfaces = new Map<string, Map<number, ChunkSummary>>();
  /** Surfaces changed since the last takeDirty(); lets callers re-cluster only those. */
  private dirty = new Set<string>();

  get chunkCount(): number {
    let n = 0;
    for (const chunks of this.surfaces.values()) n += chunks.size;
    return n;
  }

  reset(): void {
    this.revision = 0;
    for (const surface of this.surfaces.keys()) this.dirty.add(surface);
    this.surfaces.clear();
  }

  /**
   * Apply one index_changes page. Summaries and tombstones only replace what we hold if they are
   * at least as new, so overlapping or reordered pages are harmless.
   */
  apply(page: IndexPage): void {
    if (page.revision < this.revision) {
      // The mod's index went backwards (rebuilt, or a different save): our copy is meaningless.
      throw new Error(`index revision went backwards (${this.revision} -> ${page.revision})`);
    }
    for (const chunk of page.chunks) {
      const surface = this.surface(chunk.surface);
      const key = chunkKey(chunk.x, chunk.y);
      const old = surface.get(key);
      if (old && old.revision > chunk.revision) continue;
      surface.set(key, normalize(chunk));
      this.dirty.add(chunk.surface);
    }
    for (const r of page.removed) {
      const surface = this.surfaces.get(r.surface);
      const key = chunkKey(r.x, r.y);
      const old = surface?.get(key);
      if (!old || old.revision > r.revision) continue;
      surface!.delete(key);
      if (surface!.size === 0) this.surfaces.delete(r.surface);
      this.dirty.add(r.surface);
    }
    this.revision = page.revision;
  }

  takeDirty(): Set<string> {
    const dirty = this.dirty;
    this.dirty = new Set();
    return dirty;
  }

  private surface(name: string): Map<number, ChunkSummary> {
    let s = this.surfaces.get(name);
    if (!s) this.surfaces.set(name, (s = new Map()));
    return s;
  }
}

/** GameClient maps every empty Lua table to [], so an empty `entities`/`statuses` map arrives as []. */
function normalize(chunk: ChunkSummary): ChunkSummary {
  const map = <T>(v: T | unknown[] | undefined) => (Array.isArray(v) || v === undefined ? undefined : v);
  return {
    ...chunk,
    crafters: (chunk.crafters ?? []).map((c) => ({ ...c, statuses: map(c.statuses) })),
    miners: (chunk.miners ?? []).map((m) => ({ ...m, statuses: map(m.statuses) })),
    entities: map(chunk.entities) ?? {},
    labs: chunk.labs ?? 0,
  };
}
