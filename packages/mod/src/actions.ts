// Things the helper can do to the world, all through the same means a player has in remote view:
// ghosts (built by construction robots), deconstruction orders, recipe changes, and blueprints
// handed to a player's cursor. Builds are proposed first, previewed, and only placed on approval.

import { ActionResult, ItemCount, Position, ProposalSummary, RpcMethods } from "@flh/protocol";
import { LuaEntity, LuaItemStack, LuaPlayer, LuaSurface, PlayerIndex } from "factorio:runtime";
import { DIRECTIONS, addLibraryChest, dryRun, listLibrary, loadSource, nextId, requireCharted, requireVisible } from "./blueprints";
import { pushEvent, say } from "./chat";
import { markEntityDirty } from "./factory-index";
import { chunkKey, helperForce, isPositionCharted, isPositionVisible, requireKnownSurface } from "./fairness";
import { MAX_ENTITIES, boundedRegion } from "./queries";
import { refreshPanel } from "./ui";

type Params<M extends keyof RpcMethods> = RpcMethods[M]["params"];
type Result<M extends keyof RpcMethods> = RpcMethods[M]["result"];

const MAX_PREVIEW_SPRITES = 1500;
const MAX_ACTIONS = 50;
const PREVIEW_OK = { r: 0.2, g: 0.8, b: 1, a: 0.6 };
const PREVIEW_CONFLICT = { r: 1, g: 0.2, b: 0.2, a: 0.8 };

function player(index: number | undefined): LuaPlayer | undefined {
  return index === undefined ? undefined : game.get_player(index as PlayerIndex);
}

function recordAction(action: FlhAction): number {
  storage.actions ??= [];
  storage.actions.push(action);
  while (storage.actions.length > MAX_ACTIONS) storage.actions.shift();
  return action.id;
}

function countBy(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

function shift(p: Position, by: Position): Position {
  return { x: p.x + by.x, y: p.y + by.y };
}

// ---- Proposals ----

function constructionStatus(surface: LuaSurface, area: ProposalSummary["area"], cost: ItemCount[]) {
  const force = helperForce();
  const corners = [
    area.left_top,
    area.right_bottom,
    { x: area.left_top.x, y: area.right_bottom.y },
    { x: area.right_bottom.x, y: area.left_top.y },
  ];
  const covered = corners.every((c) => surface.find_logistic_networks_by_construction_area(c, force).length > 0);
  const networks = surface.find_logistic_networks_by_construction_area(
    { x: (area.left_top.x + area.right_bottom.x) / 2, y: (area.left_top.y + area.right_bottom.y) / 2 },
    force,
  );
  const missing: ItemCount[] = [];
  for (const item of cost) {
    let available = 0;
    for (const network of networks) {
      available = math.max(available, network.get_item_count({ name: item.name, quality: item.quality ?? "normal" }));
    }
    if (available < item.count) missing.push({ name: item.name, quality: item.quality, count: item.count - available });
  }
  return { covered, missing };
}

export function proposeBuild(params: Params<"propose_build">): Result<"propose_build"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const requester = player(params.player_index);
  const { stack, removed, entities } = loadSource(params.source, requester, params.label);
  const direction = DIRECTIONS[params.direction ?? "north"];
  const { ghosts, bbox } = dryRun(stack, direction, entities);

  // Shift so the build's bounding box starts at the requested top-left tile.
  const offset = {
    x: math.floor(params.position.x) - bbox.left_top.x,
    y: math.floor(params.position.y) - bbox.left_top.y,
  };
  const area = { left_top: shift(bbox.left_top, offset), right_bottom: shift(bbox.right_bottom, offset) };
  requireCharted(surface, area);

  const conflicts: { name: string; position: Position }[] = [];
  const conflicted = new LuaSet<number>();
  ghosts.forEach((ghost, index) => {
    const ok = surface.can_place_entity({
      name: ghost.name,
      position: shift(ghost.position, offset),
      direction: ghost.direction,
      force,
      build_check_type: defines.build_check_type.blueprint_ghost,
      forced: true,
    });
    if (!ok) {
      conflicted.add(index);
      conflicts.push({ name: ghost.name, position: shift(ghost.position, offset) });
    }
  });

  const id = nextId();
  const label = params.label ?? stack.label ?? `Proposal ${id}`;
  const viewers = requester ? [requester] : undefined;
  const renders: number[] = [];
  const draw = (o: { id: number }) => renders.push(o.id);
  draw(
    rendering.draw_rectangle({
      color: conflicts.length > 0 ? PREVIEW_CONFLICT : PREVIEW_OK,
      width: 3,
      left_top: area.left_top,
      right_bottom: area.right_bottom,
      surface,
      players: viewers,
    }),
  );
  draw(
    rendering.draw_text({
      text: `#${id} ${label}`,
      surface,
      target: { x: area.left_top.x, y: area.left_top.y - 1.2 },
      color: PREVIEW_OK,
      scale: 1.5,
      players: viewers,
    }),
  );
  ghosts.forEach((ghost, index) => {
    if (index >= MAX_PREVIEW_SPRITES) return;
    const color = conflicted.has(index) ? PREVIEW_CONFLICT : PREVIEW_OK;
    draw(
      rendering.draw_rectangle({
        color,
        filled: conflicted.has(index),
        left_top: shift(ghost.box.left_top, offset),
        right_bottom: shift(ghost.box.right_bottom, offset),
        surface,
        players: viewers,
        draw_on_ground: true,
      }),
    );
    if (helpers.is_valid_sprite_path(`entity/${ghost.name}`)) {
      const box = ghost.box;
      const size = math.min(box.right_bottom.x - box.left_top.x, box.right_bottom.y - box.left_top.y);
      draw(
        rendering.draw_sprite({
          sprite: `entity/${ghost.name}`,
          target: shift(ghost.position, offset),
          surface,
          players: viewers,
          x_scale: size * 0.5,
          y_scale: size * 0.5,
          tint: { r: 1, g: 1, b: 1, a: 0.6 },
        }),
      );
    }
  });

  const cost: ItemCount[] = stack.cost_to_build.map((c) => ({
    name: c.name as string,
    quality: c.quality === "normal" ? undefined : (c.quality as string),
    count: c.count,
  }));

  const design = game.create_inventory(1);
  if (!design[0]!.set_stack(stack)) throw "Could not store the design";
  storage.proposals ??= {};
  storage.proposals[id] = {
    id,
    label,
    player_index: params.player_index,
    surface: surface.name,
    design,
    build_position: offset,
    direction,
    area,
    entity_count: ghosts.length,
    conflict_count: conflicts.length,
    renders,
  };
  stack.clear();
  if (requester) refreshPanel(requester);

  return {
    id,
    surface: surface.name,
    area,
    entities: countBy(ghosts.map((g) => g.name)),
    removed_unbuildable: removed,
    conflict_count: conflicts.length,
    conflicts: conflicts.slice(0, 20),
    obstacles: surface.count_entities_filtered({ area: [area.left_top, area.right_bottom], type: ["tree", "simple-entity"] }),
    cost,
    construction: constructionStatus(surface, area, cost),
  };
}

function dropProposal(proposal: FlhProposal): void {
  for (const id of proposal.renders) rendering.get_object_by_id(id)?.destroy();
  if (proposal.design?.valid) proposal.design.destroy();
  delete storage.proposals![proposal.id];
  const requester = player(proposal.player_index);
  if (requester) refreshPanel(requester);
}

function proposalStack(proposal: FlhProposal): LuaItemStack {
  if (!proposal.design?.valid) throw `Proposal #${proposal.id} was made by an older version; propose it again`;
  return proposal.design[0]!;
}

function getProposal(id: number): FlhProposal {
  const proposal = storage.proposals?.[id];
  if (!proposal) throw `No pending proposal #${id}`;
  return proposal;
}

/** Places the proposal's ghosts. Trees and rocks in the way get marked for deconstruction. */
function buildProposal(proposal: FlhProposal, byPlayer?: LuaPlayer): { built: number; action_id: number } {
  const surface = game.get_surface(proposal.surface);
  if (!surface) throw "That surface no longer exists";
  const stack = proposalStack(proposal);
  const ghosts = stack.build_blueprint({
    surface,
    force: helperForce(),
    position: proposal.build_position,
    direction: proposal.direction,
    build_mode: defines.build_mode.forced,
    by_player: byPlayer?.connected ? byPlayer : undefined,
    raise_built: true,
  });
  const placed = ghosts
    .filter((g) => g.valid && g.type === "entity-ghost")
    .map((g) => ({ name: g.ghost_name, position: { x: g.position.x, y: g.position.y } }));
  const action_id = recordAction({ id: nextId(), kind: "build", surface: surface.name, placed });
  return { built: placed.length, action_id };
}

export type ProposalOutcome = "approved" | "rejected" | "blueprint";

/** Resolves a proposal from the GUI or an RPC; reports it to the bridge either way. */
export function resolveProposal(id: number, outcome: ProposalOutcome, by?: LuaPlayer): { built: number; action_id?: number } {
  const proposal = getProposal(id);
  let result: { built: number; action_id?: number } = { built: 0 };
  if (outcome === "approved") {
    result = buildProposal(proposal, by ?? player(proposal.player_index));
    say(`#${id} ${proposal.label}: placed ${result.built} ghosts.`, proposal.player_index);
  } else if (outcome === "blueprint") {
    const target = by ?? player(proposal.player_index);
    if (!target) throw "No player to hand the blueprint to";
    giveStack(target, proposalStack(proposal));
  }
  dropProposal(proposal);
  const actor = by ?? player(proposal.player_index);
  pushEvent({
    type: "proposal_resolved",
    tick: game.tick,
    player_index: actor?.index ?? 0,
    player_name: actor?.name ?? "server",
    id,
    outcome,
    built: result.built,
  });
  return result;
}

export function resolveProposalRpc(params: Params<"resolve_proposal">): Result<"resolve_proposal"> {
  return resolveProposal(params.id, params.outcome, player(params.player_index));
}

export function listProposals(): Result<"list_proposals"> {
  const result: Result<"list_proposals"> = [];
  for (const [, p] of pairs(storage.proposals ?? {})) result.push({ id: p.id, label: p.label, surface: p.surface, area: p.area });
  return result;
}

// ---- Blueprints in the cursor ----

function giveStack(target: LuaPlayer, blueprint: LuaItemStack): void {
  if (!target.connected) throw `${target.name} is not connected`;
  if (!target.clear_cursor()) throw `${target.name}'s cursor is busy and their inventory is full`;
  if (!target.cursor_stack?.set_stack(blueprint)) throw "Could not create the blueprint";
}

export function giveBlueprint(params: Params<"give_blueprint">): Result<"give_blueprint"> {
  const target = player(params.player_index);
  if (!target) throw "Unknown player";
  const { stack, removed } = loadSource(params.source, target, params.label);
  const entities = stack.get_blueprint_entity_count();
  giveStack(target, stack);
  stack.clear();
  return { entities, removed_unbuildable: removed };
}

// ---- Undo ----

export function undoAction(params: Params<"undo_action">): Result<"undo_action"> {
  const actions = storage.actions ?? [];
  const index = params.action_id === undefined ? actions.length - 1 : actions.findIndex((a) => a.id === params.action_id);
  const action = actions[index];
  if (!action) throw params.action_id === undefined ? "Nothing to undo" : `No action #${params.action_id}`;
  actions.splice(index, 1);
  const result = { action_id: action.id, ghosts_removed: 0, deconstruction_ordered: 0, deconstruction_cancelled: 0, recipes_restored: 0 };
  const force = helperForce();

  if (action.kind === "build") {
    const surface = game.get_surface(action.surface);
    for (const p of action.placed) {
      if (!surface) break;
      const ghost = surface.find_entities_filtered({ position: p.position, radius: 0.1, ghost_name: p.name, limit: 1 })[0];
      if (ghost !== undefined) {
        ghost.destroy();
        result.ghosts_removed++;
        continue;
      }
      const built = surface.find_entities_filtered({ position: p.position, radius: 0.1, name: p.name, force, limit: 1 })[0];
      if (built && built.order_deconstruction(force)) result.deconstruction_ordered++;
    }
  } else if (action.kind === "deconstruct") {
    for (const entity of action.entities) {
      if (entity.valid && entity.to_be_deconstructed()) {
        entity.cancel_deconstruction(force);
        result.deconstruction_cancelled++;
      }
    }
  } else if (action.kind === "recipe" && action.entity.valid) {
    returnContents(action.entity, action.entity.set_recipe(action.previous));
    markEntityDirty(action.entity);
    result.recipes_restored++;
  }
  return result;
}

// ---- Deconstruction and recipes ----

export function deconstruct(params: Params<"deconstruct">): Result<"deconstruct"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const region = boundedRegion(params, "deconstruct", { circle: false, overview: false });
  requireVisible(surface, params.area);
  const entities = surface.find_entities_filtered({
    ...region.filter,
    force,
    name: params.name as string | string[] | undefined,
    type: params.type as string | string[] | undefined,
    limit: MAX_ENTITIES + 1,
  });
  if (entities.length > MAX_ENTITIES) {
    throw `More than ${MAX_ENTITIES} entities match in that area: deconstruct it in parts or filter by name/type`;
  }
  const marked: LuaEntity[] = [];
  const by = player(params.player_index);
  for (const entity of entities) {
    if (entity.type === "character" || entity.to_be_deconstructed()) continue;
    if (entity.order_deconstruction(force, by?.connected ? by : undefined)) marked.push(entity);
  }
  const action_id = recordAction({ id: nextId(), kind: "deconstruct", entities: marked });
  return { action_id, count: marked.length };
}

/** Items a recipe change pulls out of a machine are spilled next to it, never deleted. */
function returnContents(entity: LuaEntity, items: { name: string; count: number; quality?: string }[] | undefined): void {
  for (const item of items ?? []) {
    entity.surface.spill_item_stack({ position: entity.position, stack: item, allow_belts: false, enable_looted: true, force: entity.force });
  }
}

export function setRecipe(params: Params<"set_recipe">): Result<"set_recipe"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const entity = surface.find_entities_filtered({ position: params.position, radius: 0.5, type: "assembling-machine", force, limit: 1 })[0];
  if (!entity) throw "No assembling machine of yours there";
  if (!isPositionVisible(force, surface, entity.position)) throw "That machine is not currently visible";
  if (!force.recipes[params.recipe]?.enabled) throw `Recipe '${params.recipe}' is not researched`;
  const [previous] = entity.get_recipe();
  returnContents(entity, entity.set_recipe(params.recipe));
  markEntityDirty(entity);
  const action_id = recordAction({ id: nextId(), kind: "recipe", entity, previous: previous?.name });
  return { action_id, count: 1, previous: previous?.name };
}

// ---- Finding room ----

/** Candidate spots find_space checks at most (each costs a few engine queries). */
const MAX_SPACE_CANDIDATES = 1500;
/** Largest rectangle find_space looks for, per side. */
const MAX_SPACE_SIZE = 256;

/**
 * Spirals outwards from `near` for a charted, dry, empty (trees and rocks are fine) rectangle.
 * The spiral's step grows with the search distance so that at most MAX_SPACE_CANDIDATES spots
 * are checked.
 */
export function findSpace(params: Params<"find_space">): Result<"find_space"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const width = math.ceil(params.width);
  const height = math.ceil(params.height);
  if (width > MAX_SPACE_SIZE || height > MAX_SPACE_SIZE) throw `find_space looks for at most ${MAX_SPACE_SIZE}x${MAX_SPACE_SIZE} tiles`;
  const maxDistance = math.min(params.max_distance ?? 150, 400);
  const maxRings = math.floor((math.sqrt(MAX_SPACE_CANDIDATES) - 1) / 2);
  const step = math.max(2, math.floor(math.min(width, height) / 2), math.ceil(maxDistance / maxRings));
  const cx = math.floor(params.near.x - width / 2);
  const cy = math.floor(params.near.y - height / 2);

  // Neighbouring candidates share chunks: check each chunk's chart state once.
  const charted = new LuaMap<number, boolean>();
  const isCharted = (x: number, y: number): boolean => {
    const key = chunkKey({ x, y });
    let known = charted.get(key);
    if (known === undefined) {
      known = isPositionCharted(force, surface, { x, y });
      charted.set(key, known);
    }
    return known;
  };
  const fits = (x: number, y: number): boolean => {
    for (let px = x; px < x + width + 31; px += 32) {
      for (let py = y; py < y + height + 31; py += 32) {
        if (!isCharted(math.min(px, x + width - 1), math.min(py, y + height - 1))) return false;
      }
    }
    const box: [Position, Position] = [{ x, y }, { x: x + width, y: y + height }];
    // Entities first: in a built-up area that fails fast (limit 1).
    if (surface.count_entities_filtered({ area: box, type: ["tree", "simple-entity", "fish", "corpse", "resource", "item-entity"], invert: true, limit: 1 }) > 0) return false;
    if (surface.count_tiles_filtered({ area: box, collision_mask: "water_tile", limit: 1 }) > 0) return false;
    return true;
  };

  for (let ring = 0; ring * step <= maxDistance; ring++) {
    const d = ring * step;
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ] as const) {
        if (math.abs(dx) !== ring && math.abs(dy) !== ring) continue;
        const x = cx + dx * step;
        const y = cy + dy * step;
        if (fits(x, y)) return { left_top: { x, y }, distance: d };
      }
    }
  }
  return { not_found: true };
}

// ---- Library ----

export function addLibraryChestRpc(params: Params<"add_library_chest">): Result<"add_library_chest"> {
  return { chests: addLibraryChest(params.surface, params.position) };
}

export function listBlueprints(params: Params<"list_blueprints">): Result<"list_blueprints"> {
  return listLibrary(player(params.player_index));
}

// ---- Area selection tool ----

export function registerSelection(): void {
  script.on_event(defines.events.on_player_selected_area, (event) => {
    if (event.item !== "flh-area-tool") return;
    const p = game.get_player(event.player_index)!;
    const selections = (storage.selections ??= {});
    const previous = selections[p.index];
    if (previous?.render !== undefined) rendering.get_object_by_id(previous.render)?.destroy();
    const area = {
      left_top: { x: math.floor(event.area.left_top.x), y: math.floor(event.area.left_top.y) },
      right_bottom: { x: math.ceil(event.area.right_bottom.x), y: math.ceil(event.area.right_bottom.y) },
    };
    const render = rendering.draw_rectangle({
      color: { r: 1, g: 0.65, b: 0, a: 0.8 },
      width: 2,
      left_top: area.left_top,
      right_bottom: area.right_bottom,
      surface: event.surface,
      players: [p],
    });
    selections[p.index] = { surface: event.surface.name, area, render: render.id };
    pushEvent({
      type: "area_selected",
      tick: game.tick,
      player_index: p.index,
      player_name: p.name,
      surface: event.surface.name,
      area,
      entities: countBy(event.entities.map((e) => e.name)),
    });
    p.print(
      `[color=255,165,0][FLH][/color] Marked ${area.right_bottom.x - area.left_top.x}x${area.right_bottom.y - area.left_top.y} area; mention it in your next request.`,
    );
    p.clear_cursor(); // one selection per use; the tool only lives in the cursor
  });

  script.on_event(defines.events.on_player_alt_selected_area, (event) => {
    if (event.item !== "flh-area-tool") return;
    const selection = storage.selections?.[event.player_index];
    if (selection?.render !== undefined) rendering.get_object_by_id(selection.render)?.destroy();
    delete storage.selections?.[event.player_index];
    game.get_player(event.player_index)?.clear_cursor();
  });
}
