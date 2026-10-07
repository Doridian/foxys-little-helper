// The tools the LLM can use. Each is a thin wrapper over a mod RPC; the mod enforces the
// fairness rules, so nothing here needs to (or should) bypass it.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { RpcMethod, RpcMethods } from "@flh/protocol";
import { z } from "zod";
import { GameClient, RpcError } from "./game.ts";

const position = z.object({ x: z.number(), y: z.number() });
const area = z.object({ left_top: position, right_bottom: position });
const nameFilter = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Prototype name(s), e.g. 'assembling-machine-2'");
const typeFilter = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Prototype type(s), e.g. 'assembling-machine', 'inserter', 'transport-belt'");

export function createTools(game: GameClient) {
  async function rpc<M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]): Promise<string> {
    try {
      return JSON.stringify(await game.call(method, params));
    } catch (err) {
      if (err instanceof RpcError) throw new ToolError(err.message);
      throw err;
    }
  }

  return [
    betaZodTool({
      name: "game_info",
      description:
        "Overview of the game: current tick, research, players (with surface and position), and every surface the force has charted (planets and space platforms) with charted/visible chunk counts. Call this first to orient yourself.",
      inputSchema: z.object({}),
      run: () => rpc("game_info", {}),
    }),
    betaZodTool({
      name: "production",
      description:
        "Production and consumption rates (per minute) on one surface, from the production statistics window. Without `items`, returns the busiest items and fluids.",
      inputSchema: z.object({
        surface: z.string().describe("Surface name, e.g. 'nauvis', 'gleba'"),
        items: z.array(z.string()).optional().describe("Item or fluid names to report"),
        window: z.enum(["1m", "10m", "1h"]).default("10m"),
        limit: z.number().int().positive().max(200).optional(),
      }),
      run: (input) => rpc("production", input),
    }),
    betaZodTool({
      name: "status_summary",
      description:
        "Group the force's entities by (name, recipe, status) and count them, with a few example positions per group. Best first step for 'why is X stuck?': e.g. filter by recipe and look for statuses like item_ingredient_shortage, full_output, no_power, low_power, waiting_for_source_items. Only chunks currently visible (radar coverage) are included.",
      inputSchema: z.object({
        surface: z.string(),
        area: area.optional().describe("Restrict to this area; omit for the whole surface"),
        name: nameFilter,
        type: typeFilter,
        recipe: z.string().optional().describe("Only crafting machines using this recipe"),
      }),
      run: (input) => rpc("status_summary", input),
    }),
    betaZodTool({
      name: "find_entities",
      description:
        "List entities (name, type, position, status, recipe, unit_number) in an area or radius. Only currently visible chunks are included; `skipped_not_visible` counts the rest.",
      inputSchema: z.object({
        surface: z.string(),
        area: area.optional(),
        position: position.optional().describe("Center for a radius search"),
        radius: z.number().positive().optional(),
        name: nameFilter,
        type: typeFilter,
        limit: z.number().int().positive().max(1000).optional(),
      }),
      run: (input) => rpc("find_entities", input),
    }),
    betaZodTool({
      name: "inspect_entity",
      description:
        "Detailed live state of one entity: status, recipe, crafting progress, inventories, fluids, energy, inserter hand, belt contents. Identify it by unit_number, or by position (+ optional name).",
      inputSchema: z.object({
        surface: z.string(),
        unit_number: z.number().int().optional(),
        position: position.optional(),
        name: z.string().optional(),
      }),
      run: (input) => rpc("inspect_entity", input),
    }),
  ];
}
