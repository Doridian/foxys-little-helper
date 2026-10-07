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
  | { type: "player_cancel"; tick: number; player_index: number; player_name: string };

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
  unit_number?: number;
  name: string;
  type: string;
  position: Position;
  status?: string;
  recipe?: string;
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
  /** For inserters: what they are holding. */
  held_stack?: { name: string; count: number };
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

export interface RpcMethods {
  poll_events: { params: Record<string, never>; result: GameEvent[] };
  say: { params: { player_index?: number; message: string }; result: true };
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
    };
    result: { entities: EntitySummary[]; truncated: boolean; skipped_not_visible: number };
  };
  status_summary: {
    params: { surface: string; area?: Area; name?: string | string[]; type?: string | string[]; recipe?: string };
    result: { rows: StatusSummaryRow[]; skipped_not_visible: number };
  };
  inspect_entity: {
    params: { surface: string; unit_number?: number; position?: Position; name?: string };
    result: EntityDetails;
  };
}

export type RpcMethod = keyof RpcMethods;
