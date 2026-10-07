import { Area, GameEvent, Position } from "@flh/protocol";
import { LuaEntity, LuaInventory } from "factorio:runtime";

declare global {
  interface FlhProposal {
    id: number;
    label: string;
    player_index?: number;
    surface: string;
    /** One-slot inventory holding the (already fairness-filtered) blueprint; cheaper than a string. */
    design: LuaInventory;
    /** Where build_blueprint must be called to land on the previewed spot. */
    build_position: Position;
    direction: number;
    area: Area;
    entity_count: number;
    conflict_count: number;
    renders: number[];
  }

  type FlhAction =
    | { id: number; kind: "build"; surface: string; placed: { name: string; position: Position }[] }
    | { id: number; kind: "deconstruct"; entities: LuaEntity[] }
    | { id: number; kind: "recipe"; entity: LuaEntity; previous?: string };

  interface FlhRequestStatus {
    text: string;
    state: "queued" | "thinking" | "stopping";
    detail?: string;
    since: number;
  }

  // ---- Places ----
  interface FlhPlace {
    id: number;
    name: string;
    surface: string;
    /** The point, or the centre of `area`. */
    position: Position;
    area?: Area;
    note?: string;
    /** Name of the player who named it. */
    author?: string;
    tick: number;
  }
  // ---- End places ----
  // ---- Factory index (factory-index.ts) ----
  /** One chunk. Without `j` it's a tombstone: it once held our entities, now doesn't. */
  interface FlhIndexChunk {
    /** Revision and tick of the last write. */
    r?: number;
    t?: number;
    /** Canonical JSON summary without its opening "{" (see indexChanges). */
    j?: string;
    /** Previous/next chunk (global key) in revision order. */
    p?: number;
    n?: number;
    /** Names to count in bulk next time (see summarise). */
    b?: string[];
  }

  interface FlhIndexSurface {
    name: string;
    /** By local chunk key. Never shrinks (tombstones stay), so it's safe to iterate with next() across ticks. */
    chunks: LuaMap<number, FlhIndexChunk>;
    live: number;
    pending: number;
    pass_start?: number;
    last_full_pass?: number;
    deleted?: true;
  }

  interface FlhIndex {
    version: number;
    revision: number;
    surfaces: LuaMap<number, FlhIndexSurface>;
    /** Revision-ordered list of chunks by global key. */
    head?: number;
    tail?: number;
    by_revision: LuaMap<number, number>;
    /** Dirty set and its FIFO (index -> global key). */
    dirty: LuaMap<number, true>;
    queue: LuaMap<number, number>;
    queue_first: number;
    queue_last: number;
    /** Chunks with our entities that the force hasn't charted yet. */
    uncharted: LuaMap<number, true>;
    /** First-run discovery: chunks (global keys) to check, and the next position. */
    seed: number[];
    seed_pos: number;
    /** Work budget left this tick, in chunks; negative = debt from an expensive chunk. */
    budget: number;
    /** Round-robin cursor. */
    rr_surface?: number;
    rr_chunk?: number;
    /** Discovery sweep (finds entities created without events): generated-chunk bounds per surface, cursor. */
    sweep?: LuaMap<number, FlhIndexSweep>;
    sweep_surface?: number;
  }

  interface FlhIndexSweep {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cx: number;
    cy: number;
  }

  const storage: {
    events?: GameEvent[];
    next_id?: number;
    proposals?: Record<number, FlhProposal>;
    actions?: FlhAction[];
    selections?: Record<number, { surface: string; area: Area; render?: number }>;
    library?: LuaEntity[];
    requests?: Record<number, FlhRequestStatus>;
    scratch?: LuaInventory;
    history?: Record<number, { from: "you" | "flh"; text: string }[]>;
    // ---- Places ----
    places?: Record<number, FlhPlace>;
    next_place_id?: number;
    index?: FlhIndex;
  };
}
