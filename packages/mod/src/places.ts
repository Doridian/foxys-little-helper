// Named places: the force's map tags (names players already gave things) plus places players
// named through the helper ("this is the iron bus"), kept in storage so they are saved with the
// game and shared by everyone on the force. Only charted spots count, like any map knowledge.

import { Area, Place, Position, RpcMethods } from "@flh/protocol";
import { LuaCustomChartTag, LuaForce, LuaSurface, PlayerIndex, SignalID } from "factorio:runtime";
import { helperForce, isPositionCharted, requireKnownSurface } from "./fairness";

type Params<M extends keyof RpcMethods> = RpcMethods[M]["params"];
type Result<M extends keyof RpcMethods> = RpcMethods[M]["result"];

const MAX_PLACES = 500;
const MAX_NAME = 100;
const MAX_NOTE = 500;

/** Rich text for a tag icon; virtual signals are `[virtual-signal=...]`, everything else uses its type. */
function iconText(icon: SignalID | undefined): string | undefined {
  if (!icon?.name) return undefined;
  const type = icon.type ?? "item";
  return `[${type === "virtual" ? "virtual-signal" : type}=${icon.name}]`;
}

function fromTag(tag: LuaCustomChartTag): Place {
  const icon = iconText(tag.icon);
  return {
    source: "map_tag",
    name: tag.text !== "" ? tag.text : (icon ?? "(unnamed tag)"),
    surface: tag.surface.name,
    position: { x: tag.position.x, y: tag.position.y },
    icon,
    author: tag.last_user?.name,
  };
}

function fromStored(p: FlhPlace): Place {
  return {
    source: "remembered",
    id: p.id,
    name: p.name,
    surface: p.surface,
    position: p.position,
    area: p.area,
    note: p.note,
    author: p.author,
    tick: p.tick,
  };
}

function matches(place: Place, text: string | undefined): boolean {
  if (text === undefined || text === "") return true;
  const needle = text.toLowerCase();
  return string.find(place.name.toLowerCase(), needle, 1, true)[0] !== undefined
    || (place.note !== undefined && string.find(place.note.toLowerCase(), needle, 1, true)[0] !== undefined);
}

function tagsOn(force: LuaForce, surface: LuaSurface): Place[] {
  const result: Place[] = [];
  for (const tag of force.find_chart_tags(surface)) {
    if (isPositionCharted(force, surface, tag.position)) result.push(fromTag(tag));
  }
  return result;
}

export function listPlaces(params: Params<"list_places">): Result<"list_places"> {
  const force = helperForce();
  const result: Place[] = [];
  for (const [, surface] of game.surfaces) {
    if (params.surface !== undefined && surface.name !== params.surface) continue;
    for (const place of tagsOn(force, surface)) {
      if (matches(place, params.text)) result.push(place);
    }
  }
  for (const [, stored] of pairs(storage.places ?? {})) {
    if (params.surface !== undefined && stored.surface !== params.surface) continue;
    const place = fromStored(stored);
    if (matches(place, params.text)) result.push(place);
  }
  return result;
}

function findByName(name: string): FlhPlace | undefined {
  const lower = name.toLowerCase();
  for (const [, p] of pairs(storage.places ?? {})) {
    if (p.name.toLowerCase() === lower) return p;
  }
  return undefined;
}

function normalizeArea(area: Area): Area {
  return {
    left_top: { x: math.min(area.left_top.x, area.right_bottom.x), y: math.min(area.left_top.y, area.right_bottom.y) },
    right_bottom: { x: math.max(area.left_top.x, area.right_bottom.x), y: math.max(area.left_top.y, area.right_bottom.y) },
  };
}

export function rememberPlace(params: Params<"remember_place">): Result<"remember_place"> {
  const force = helperForce();
  const surface = requireKnownSurface(force, params.surface);
  const name = params.name.trim();
  if (name === "") throw "A place needs a name";
  if (name.length > MAX_NAME) throw `Name too long (max ${MAX_NAME} characters)`;
  if (params.note !== undefined && params.note.length > MAX_NOTE) throw `Note too long (max ${MAX_NOTE} characters)`;
  if ((params.position === undefined) === (params.area === undefined)) throw "Give exactly one of position or area";

  const area = params.area ? normalizeArea(params.area) : undefined;
  const position: Position = area
    ? { x: (area.left_top.x + area.right_bottom.x) / 2, y: (area.left_top.y + area.right_bottom.y) / 2 }
    : { x: params.position!.x, y: params.position!.y };
  // Naming a spot is map knowledge: it has to be somewhere the force has charted.
  const corners = area ? [area.left_top, area.right_bottom, position] : [position];
  for (const corner of corners) {
    if (!isPositionCharted(force, surface, corner)) throw `${corner.x},${corner.y} on ${surface.name} has not been charted`;
  }

  const existing = findByName(name);
  const places = (storage.places ??= {});
  if (!existing && table_size(places) >= MAX_PLACES) throw `Too many remembered places (max ${MAX_PLACES}); forget some first`;
  const id = existing?.id ?? (storage.next_place_id = (storage.next_place_id ?? 0) + 1);
  const author = params.player_index !== undefined ? game.get_player(params.player_index as PlayerIndex)?.name : undefined;
  // Moving a place keeps its note unless a new one is given.
  const note = params.note ?? existing?.note;
  places[id] = { id, name, surface: surface.name, position, area, note, author: author ?? existing?.author, tick: game.tick };
  return { place: fromStored(places[id]), replaced: existing ? fromStored(existing) : undefined };
}

export function forgetPlace(params: Params<"forget_place">): Result<"forget_place"> {
  if (params.id === undefined && params.name === undefined) throw "Give the id or name of the place to forget";
  const forgotten: Place[] = [];
  const places = storage.places ?? {};
  const target = params.id !== undefined ? places[params.id] : findByName(params.name!);
  if (target) {
    forgotten.push(fromStored(target));
    delete places[target.id];
  }
  return { forgotten };
}
