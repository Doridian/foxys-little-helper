// Typed RPC client for the mod's /flh-rpc command.

import type { RpcMethod, RpcMethods, RpcRequest, RpcResponse } from "@flh/protocol";
import { Rcon } from "./rcon.ts";

export class RpcError extends Error {}

/**
 * Lua has no distinction between empty arrays and empty objects, so helpers.table_to_json
 * turns every empty array into `{}`. Our protocol never uses meaningful empty objects in
 * results, so map them back to arrays.
 */
function fixEmptyTables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixEmptyTables);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return [];
    return Object.fromEntries(entries.map(([k, v]) => [k, fixEmptyTables(v)]));
  }
  return value;
}

export class GameClient {
  private nextId = 1;

  constructor(private readonly rcon: Rcon) {}

  async call<M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    const request: RpcRequest<M> = { id: this.nextId++, method, params };
    const raw = await this.rcon.exec(`/flh-rpc ${JSON.stringify(request)}`);
    let response: RpcResponse;
    try {
      response = JSON.parse(raw) as RpcResponse;
    } catch {
      throw new RpcError(`Unexpected RCON output (is the mod loaded?): ${raw.slice(0, 200)}`);
    }
    if (response.id !== request.id) throw new RpcError(`RPC id mismatch: sent ${request.id}, got ${response.id}`);
    if (!response.ok) throw new RpcError(response.error);
    return fixEmptyTables(response.result) as RpcMethods[M]["result"];
  }
}
