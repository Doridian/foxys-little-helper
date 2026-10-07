// The tools the LLM can use. Each is a thin wrapper over a mod RPC; the mod enforces the
// fairness rules, so nothing here needs to (or should) bypass it.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { RpcMethod, RpcMethods } from "@flh/protocol";
import { z } from "zod";
import { GameClient, RpcError } from "./game.ts";
import type { PlannerService } from "./planner/service.ts";

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

export function createTools(game: GameClient, planner: PlannerService) {
  async function json(fn: () => Promise<unknown>): Promise<string> {
    try {
      return JSON.stringify(await fn());
    } catch (err) {
      if (err instanceof RpcError) throw new ToolError(err.message);
      throw err;
    }
  }
  const rpc = <M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]) => json(() => game.call(method, params));

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
    betaZodTool({
      name: "lookup_recipes",
      description:
        "Which recipes make an item or fluid (with ingredients, products, time, whether researched, surface conditions), which recipes use it, and which resources it is mined from.",
      inputSchema: z.object({ item: z.string().describe("Item or fluid name, e.g. 'electronic-circuit', 'petroleum-gas'") }),
      run: ({ item }) => json(() => planner.recipes(item)),
    }),
    betaZodTool({
      name: "plan_production",
      description: `Calculate a production line for a target rate on a surface: recipe chain, machine counts (fractional; build the ceiling), power, raw inputs, byproducts and mining drills. Uses only researched recipes and machines by default, picks the best available machine per recipe, and respects planet surface conditions.

Also returns \`current\`: current production/consumption of every involved item on that surface (10 minute average) and existing machines per recipe with their statuses, so you can work out the gap ("making 62/min, need 100").

Notes: \`rate\` is what the new line should produce, so to raise production to a total, plan for the difference. Use \`inputs\` for items already available (e.g. plates from the main bus) so they are not expanded. Byproducts are not credited against other demand, so oil processing and recipe loops are approximate; read the warnings.`,
      inputSchema: z.object({
        surface: z.string().describe("Where it will be built, e.g. 'nauvis'"),
        item: z.string(),
        rate_per_min: z.number().positive(),
        inputs: z.array(z.string()).optional().describe("Items supplied externally; not expanded further"),
        recipes: z.record(z.string(), z.string()).optional().describe("item -> recipe overrides"),
        machines: z.record(z.string(), z.string()).optional().describe("recipe or recipe category -> machine overrides"),
        modules: z
          .array(
            z.object({
              machine: z.string(),
              modules: z.array(z.string()).optional(),
              beacons: z.object({ name: z.string(), count: z.number().int().positive(), modules: z.array(z.string()) }).optional(),
            }),
          )
          .optional()
          .describe("Modules (and beacons) to assume per machine type"),
        allow_locked: z.boolean().optional().describe("Allow recipes/machines that are not researched yet"),
      }),
      run: (input) =>
        json(() =>
          planner.plan(input.surface, {
            item: input.item,
            rate: input.rate_per_min,
            inputs: input.inputs,
            recipes: input.recipes,
            machines: input.machines,
            modules: input.modules,
            allowLocked: input.allow_locked,
          }),
        ),
    }),
  ];
}
