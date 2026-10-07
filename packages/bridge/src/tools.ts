// The tools the LLM can use. Each is a thin wrapper over a mod RPC; the mod enforces the
// fairness rules, so nothing here needs to (or should) bypass it.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BlueprintSource, RpcMethod, RpcMethods } from "@flh/protocol";
import { z } from "zod";
import type { DesignStore } from "./designs.ts";
import { factoryIndex } from "./factory/service.ts";
import type { GameClient } from "./game.ts";
import { assemblerRow } from "./layouts.ts";
import type { PlannerService } from "./planner/service.ts";
import { searchPlaces } from "./places.ts";

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

export interface ToolContext {
  game: GameClient;
  planner: PlannerService;
  designs: DesignStore;
  /** The player whose conversation this is: previews, dialogs and blueprints go to them. */
  playerIndex: number;
}

const direction = z.enum(["north", "east", "south", "west"]).optional().describe("Rotation of the design (default north = as designed)");
const designSource = {
  design: z.string().optional().describe("Design id from list_blueprints or generate_layout"),
  copy_area: area.optional().describe("Copy what is built in this (visible) area instead, on the same surface"),
  blueprint_string: z.string().optional().describe("A blueprint exchange string the player pasted"),
};

/**
 * Largest tool result we hand to the model, in characters. Results stay in the conversation until
 * the server clears them (see context.ts), and the history must not be edited afterwards, so the size
 * is decided here, once. 24k characters of our JSON is roughly 8k tokens: room for a few hundred
 * entities or a full plan, while a query over a megabase that would return thousands of rows becomes
 * a short error telling the model how to narrow it instead of flooding the context.
 */
export const MAX_RESULT_CHARS = 24_000;

export function createTools({ game, planner, designs, playerIndex }: ToolContext) {
  async function json(fn: () => Promise<unknown>): Promise<string> {
    try {
      const text = JSON.stringify(await fn());
      if (text.length > MAX_RESULT_CHARS) {
        throw new ToolError(
          `Result too large (${text.length} characters, limit ${MAX_RESULT_CHARS}). Narrow the query: a smaller area or radius, ` +
            "filters (name, type, recipe, items, surface, text), or a lower limit; or summarise first (status_summary) and then drill into one spot.",
        );
      }
      return text;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      // Errors from the mod and from our own validation are things the model can act on.
      if (err instanceof Error) throw new ToolError(err.message);
      throw err;
    }
  }

  function source(surface: string, input: { design?: string; copy_area?: z.infer<typeof area>; blueprint_string?: string }): BlueprintSource {
    const given = [input.design, input.copy_area, input.blueprint_string].filter((x) => x !== undefined).length;
    if (given !== 1) throw new Error("Give exactly one of design, copy_area or blueprint_string");
    if (input.design) return designs.source(input.design);
    if (input.copy_area) return { kind: "copy", surface, area: input.copy_area };
    return { kind: "string", string: input.blueprint_string! };
  }
  const rpc = <M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]) => json(() => game.call(method, params));
  const factory = factoryIndex(game, planner);

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
        "List your force's entities (name, type, position, status, recipe; for inserters `moves` = which entity they take from and put into) in an area or radius. Set all_forces to also see trees, rocks and enemies. Only currently visible chunks are included; `skipped_not_visible` counts the rest.",
      inputSchema: z.object({
        surface: z.string(),
        area: area.optional(),
        position: position.optional().describe("Center for a radius search"),
        radius: z.number().positive().optional(),
        name: nameFilter,
        type: typeFilter,
        limit: z.number().int().positive().max(1000).optional(),
        all_forces: z.boolean().optional(),
      }),
      run: (input) => rpc("find_entities", input),
    }),
    betaZodTool({
      name: "inspect_entity",
      description:
        "Detailed live state of one entity at a position (from find_entities etc.): status, recipe, crafting progress, inventories, fluids, energy, belt contents, and for inserters the hand plus exact pickup/drop positions and entities. Pass `name` when several entities share a spot.",
      inputSchema: z.object({
        surface: z.string(),
        position,
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

    // ---- Factory index (factory/): production blocks clustered from the mod's chunk summaries ----
    betaZodTool({
      name: "factory_overview",
      description:
        "Map of the whole factory from the factory index: per surface, how many production blocks and machines, overall health, the biggest blocks (what they make, where, [gps] link) and the blocks with the most problems. Start here for questions about anything not right in front of the player.",
      inputSchema: z.object({ surface: z.string().optional().describe("Only this surface") }),
      run: ({ surface }) => json(() => factory.overview(surface)),
    }),
    betaZodTool({
      name: "search_factory",
      description: `Find production blocks (areas of related machines) in the factory index, best match first. Each result: id, surface, [gps] link, size in tiles, machine count, top recipes, health, train stations, and why it matched.

- item: blocks making it (ranked by how much of the block does) or using it. Common names work: "blue circuit", "gleba science".
- recipe: crafting recipe name.
- text: free text matched against recipes, items, train station names and named places, e.g. "iron smelting", "oil", "Gleba science build".
- near: rank by distance from a position (combine with surface).
- problems_only: only blocks with machines in a problem status (ingredient shortage, no power...), worst first.
Then use describe_block on an id for detail.`,
      inputSchema: z.object({
        surface: z.string().optional(),
        item: z.string().optional(),
        recipe: z.string().optional(),
        text: z.string().optional(),
        near: position.optional(),
        problems_only: z.boolean().optional(),
        limit: z.number().int().positive().max(30).optional(),
      }),
      run: (input) => json(() => factory.search(input)),
    }),
    betaZodTool({
      name: "describe_block",
      description:
        "Detail for one production block from search_factory/factory_overview: tile area and [gps] links, recipes and mining with machine types, status counts and where each recipe sits, inputs it needs and outputs it exports, stations, roboports, and the chunks with problems (areas to pass to status_summary or find_entities). Statuses are from when each chunk was last summarised while visible.",
      inputSchema: z.object({ id: z.string().describe("Block id, e.g. 'nauvis#3'") }),
      run: ({ id }) => json(() => factory.describe(id)),
    }),
    // ---- end factory index ----

    // ---- Places ----
    betaZodTool({
      name: "list_places",
      description:
        "Named places: map tags players placed (their text and icon) and places players named through you (remember_place). Use it to resolve a name a player uses (\"the iron bus\", \"Gleba science\") to a surface and position/area. With `text`, returns the best matches first (every word must match the start of a word in the name or note).",
      inputSchema: z.object({
        text: z.string().optional().describe("Words to search for, e.g. 'iron bus'"),
        surface: z.string().optional(),
      }),
      run: (input) =>
        json(async () => {
          if (input.text) return searchPlaces(game, input.text, { surface: input.surface });
          return game.call("list_places", { surface: input.surface });
        }),
    }),
    betaZodTool({
      name: "remember_place",
      description:
        "Remember a name for a spot or area of the factory for everyone on the force (saved with the game), e.g. when a player says \"this is the Gleba science build\". Give a position or an area (charted). Remembering an existing name again moves/updates it.",
      inputSchema: z.object({
        name: z.string().describe("The name as the player said it"),
        surface: z.string(),
        position: position.optional(),
        area: area.optional(),
        note: z.string().optional().describe("Short note: what it is, what it makes or feeds"),
      }),
      run: (input) => rpc("remember_place", { ...input, player_index: playerIndex }),
    }),
    betaZodTool({
      name: "forget_place",
      description: "Forget a place remembered with remember_place, by id or name. Map tags belong to the players; they remove those on the map themselves.",
      inputSchema: z.object({ id: z.number().int().optional(), name: z.string().optional() }),
      run: (input) => rpc("forget_place", input),
    }),

    // ---- Acting ----
    betaZodTool({
      name: "list_blueprints",
      description:
        "Designs available to build: blueprints in registered library chests and the player's inventory (ids like c0/3), and blueprint strings from the repo (repo:...). Each has label, description, size, entity and recipe counts.",
      inputSchema: z.object({}),
      run: () => json(() => designs.list(playerIndex)),
    }),
    betaZodTool({
      name: "add_library_chest",
      description: "Register a chest (by position) whose blueprints and blueprint books the helper may use, e.g. after the player marks one.",
      inputSchema: z.object({ surface: z.string(), position }),
      run: (input) => rpc("add_library_chest", input),
    }),
    betaZodTool({
      name: "generate_layout",
      description: `Generate a layout when no existing blueprint fits. Returns a design id for propose_build/give_blueprint plus size, notes (where to connect belts and power) and throughput.

Layouts:
- assembler_row: a row of \`count\` 3x3 machines for one recipe between an input belt (top, flows east) and an output belt (bottom, flows west), with inserters and poles. Solid recipes with at most 2 ingredients. Picks the best researched machine, inserter, belt and pole unless given.`,
      inputSchema: z.object({
        layout: z.enum(["assembler_row"]),
        recipe: z.string(),
        count: z.number().int().positive().max(40),
        machine: z.string().optional(),
        inserter: z.string().optional(),
        belt: z.string().optional(),
        pole: z.string().optional(),
      }),
      run: (input) =>
        json(async () => {
          const [data, force] = await Promise.all([planner.planner(), planner.force()]);
          const layout = assemblerRow(data, force, input);
          const id = designs.addGenerated(layout);
          return { design: id, label: layout.label, width: layout.width, height: layout.height, crafts_per_min: layout.crafts_per_min, notes: layout.notes };
        }),
    }),
    betaZodTool({
      name: "find_space",
      description: "Find the nearest free, charted, dry rectangle (trees and rocks are fine, they get cleared) of the given size near a position. Returns its top-left corner.",
      inputSchema: z.object({
        surface: z.string(),
        width: z.number().positive(),
        height: z.number().positive(),
        near: position,
        max_distance: z.number().positive().optional(),
      }),
      run: (input) => rpc("find_space", input),
    }),
    betaZodTool({
      name: "propose_build",
      description: `Show the player a preview of a build and ask for approval. Nothing is placed yet: the player sees outlines (red where blocked) and Build / Blueprint / Reject buttons, or can answer in chat (then use resolve_proposal).

\`position\` is the top-left corner of the build. The result lists entity counts, blocked spots, trees/rocks to clear, total cost, and whether construction robots cover the area and what items the network lacks. Mention blockers and missing items to the player. Entities players can't build (script-only ones) are removed and reported.`,
      inputSchema: z.object({
        surface: z.string(),
        position,
        direction,
        label: z.string().optional().describe("Short name shown on the preview"),
        ...designSource,
      }),
      run: (input) =>
        json(() =>
          game.call("propose_build", {
            surface: input.surface,
            position: input.position,
            direction: input.direction,
            label: input.label,
            source: source(input.surface, input),
            player_index: playerIndex,
          }),
        ),
    }),
    betaZodTool({
      name: "resolve_proposal",
      description:
        "Act on a pending proposal when the player answers in chat: approved = place the ghosts (robots build them), blueprint = put it in the player's cursor to place themselves, rejected = discard the preview.",
      inputSchema: z.object({ id: z.number().int(), outcome: z.enum(["approved", "rejected", "blueprint"]) }),
      run: (input) => rpc("resolve_proposal", { ...input, player_index: playerIndex }),
    }),
    betaZodTool({
      name: "give_blueprint",
      description: "Put a design into the player's cursor as a blueprint so they can place it themselves (no preview or approval needed).",
      inputSchema: z.object({ surface: z.string().describe("Surface for copy_area"), label: z.string().optional(), ...designSource }),
      run: (input) => json(() => game.call("give_blueprint", { player_index: playerIndex, label: input.label, source: source(input.surface, input) })),
    }),
    betaZodTool({
      name: "deconstruct",
      description:
        "Mark the force's entities in a visible area for deconstruction by robots, optionally only certain names/types. Destructive: unless the player explicitly asked for exactly this, describe what would be removed and get a yes first.",
      inputSchema: z.object({ surface: z.string(), area, name: nameFilter, type: typeFilter }),
      run: (input) => rpc("deconstruct", { ...input, player_index: playerIndex }),
    }),
    betaZodTool({
      name: "set_recipe",
      description: "Change the recipe of an assembling machine (by position). Items it held are spilled next to it, not lost.",
      inputSchema: z.object({ surface: z.string(), position, recipe: z.string() }),
      run: (input) => rpc("set_recipe", { ...input, player_index: playerIndex }),
    }),
    betaZodTool({
      name: "undo",
      description:
        "Undo one of your actions (default: the latest): removes ghosts not built yet and orders deconstruction of ones already built, cancels deconstruction orders, or restores a recipe.",
      inputSchema: z.object({ action_id: z.number().int().optional() }),
      run: (input) => rpc("undo_action", input),
    }),
  ];
}
