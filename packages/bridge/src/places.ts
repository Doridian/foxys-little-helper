// Named places (map tags + places remembered through the helper), searchable by text. The mod
// stores and filters them; ranking lives here so other searches (e.g. the factory index) can merge
// places into their own results through searchPlaces().

import type { Place } from "@flh/protocol";
import type { GameClient } from "./game.ts";

export interface PlaceMatch extends Place {
  /** Higher is better; only meaningful relative to other matches of the same query. */
  score: number;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
}

/**
 * Scores a place against a query: every query word must appear in the name or note (as a prefix of
 * one of its words, so "sci" finds "Gleba science build"). An exact name scores highest, then all
 * words in the name, then matches that need the note.
 */
export function scorePlace(place: Place, query: string): number {
  const q = words(query);
  if (q.length === 0) return 1;
  const name = words(place.name);
  const note = words(place.note ?? "");
  if (name.join(" ") === q.join(" ")) return 100;
  let score = 0;
  for (const word of q) {
    if (name.includes(word)) score += 10;
    else if (name.some((w) => w.startsWith(word))) score += 6;
    else if (note.some((w) => w.startsWith(word))) score += 2;
    else return 0;
  }
  // Prefer places named by players through the helper slightly over map tags with the same score,
  // and shorter names (closer to the query) over longer ones.
  return score + (place.source === "remembered" ? 1 : 0) - name.length * 0.1;
}

export function rankPlaces(places: Place[], query: string, limit = 20): PlaceMatch[] {
  return places
    .map((place) => ({ ...place, score: scorePlace(place, query) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Places a free-text query refers to: the query matches the place (rankPlaces), or the place's whole
 * name appears in the query ("is the gear island short on power?" mentions "Gear island").
 */
export function placesMentioned(places: Place[], query: string, limit = 5): PlaceMatch[] {
  const q = ` ${words(query).join(" ")} `;
  const byName = places
    .filter((p) => words(p.name).length > 0 && q.includes(` ${words(p.name).join(" ")} `))
    .map((p) => ({ ...p, score: 100 }));
  const seen = new Set(byName.map((p) => `${p.source}:${p.id ?? p.name}`));
  const ranked = rankPlaces(places, query, limit).filter((p) => !seen.has(`${p.source}:${p.id ?? p.name}`));
  return [...byName, ...ranked].slice(0, limit);
}

/** Places matching `text` (best first), optionally on one surface. */
export async function searchPlaces(game: GameClient, text: string, options: { surface?: string; limit?: number } = {}): Promise<PlaceMatch[]> {
  const places = await game.call("list_places", { surface: options.surface });
  return rankPlaces(places, text, options.limit);
}
