import assert from "node:assert/strict";
import { it } from "node:test";
import type { Place } from "@flh/protocol";
import { placesMentioned, rankPlaces } from "./places.ts";

const at = { x: 0, y: 0 };
const places: Place[] = [
  { source: "map_tag", name: "Iron smelting", surface: "nauvis", position: at },
  { source: "remembered", id: 1, name: "Gleba science build", surface: "gleba", position: at },
  { source: "remembered", id: 2, name: "Main bus", surface: "nauvis", position: at, note: "iron, copper and steel lanes" },
  { source: "map_tag", name: "[item=iron-plate]", surface: "nauvis", position: at },
];

it("finds places by word prefixes in name or note, best first", () => {
  assert.deepEqual(rankPlaces(places, "iron").map((p) => p.name), ["Iron smelting", "[item=iron-plate]", "Main bus"]);
  assert.deepEqual(rankPlaces(places, "gleba sci").map((p) => p.name), ["Gleba science build"]);
  assert.deepEqual(rankPlaces(places, "the bus").map((p) => p.name), []);
});

it("ranks an exact name first", () => {
  assert.equal(rankPlaces(places, "main bus")[0]?.name, "Main bus");
});

it("returns everything for an empty query", () => {
  assert.equal(rankPlaces(places, "").length, places.length);
});

it("finds places named inside a longer question", () => {
  assert.deepEqual(placesMentioned(places, "is the main bus short on iron?").map((p) => p.name)[0], "Main bus");
  assert.deepEqual(placesMentioned(places, "what's wrong with gleba science build").map((p) => p.name), ["Gleba science build"]);
  assert.deepEqual(placesMentioned(places, "where do we make gears"), []);
});
