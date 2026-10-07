import assert from "node:assert/strict";
import { it } from "node:test";
import { FactorioPrints, searchSummaries, titleWords } from "./factorio-prints.ts";

const summaries = [
  { key: "a", title: "Tileable Science Production 1.0-2.0", favorites: 4000 },
  { key: "b", title: "Modular Green Circuits", favorites: 300 },
  { key: "c", title: "[item=electronic-circuit] 1200/min beaconed", favorites: 50 },
  { key: "d", title: "Compact green circuit build", favorites: 10 },
  { key: "e", title: "Red circuits (advanced-circuit) 2.0", favorites: 900 },
];

it("splits titles into words, expanding rich text and stemming plurals", () => {
  assert.deepEqual(titleWords("[item=electronic-circuit] Green Circuits!"), ["electronic", "circuit", "green", "circuit"]);
});

it("matches every query word, popular first", () => {
  assert.deepEqual(searchSummaries(summaries, "green circuits", 5).map((s) => s.key), ["b", "c", "d"]);
  assert.deepEqual(searchSummaries(summaries, "red circuit blueprint", 5).map((s) => s.key), ["e"]);
  assert.deepEqual(searchSummaries(summaries, "", 2).map((s) => s.key), ["a", "e"]);
});

it("filters by tag and resolves short tag names", async () => {
  const calls: string[] = [];
  const prints = new FactorioPrints(async (url) => {
    calls.push(url);
    if (url.endsWith("/blueprintSummaries.json")) return Object.fromEntries(summaries.map((s) => [s.key, { title: s.title, numberOfFavorites: s.favorites }]));
    if (url.endsWith("/tags.json")) return { production: ["electronic circuit (green)"], belt: ["balancer"] };
    if (url.includes("/byTag/production/electronic%20circuit%20(green).json")) return { b: true, d: true };
    throw new Error(`unexpected ${url}`);
  });
  assert.deepEqual((await prints.search("circuit", { tag: "electronic circuit (green)" })).map((s) => s.key), ["b", "d"]);
  await assert.rejects(prints.search("x", { tag: "nope" }), /Unknown tag 'nope'. Tags: \/production\/electronic circuit \(green\)\/, \/belt\/balancer\//);
  await prints.search("green");
  assert.equal(calls.filter((u) => u.endsWith("/blueprintSummaries.json")).length, 1);
});
