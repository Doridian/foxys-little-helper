import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChunkSummary, RpcMethods } from "@flh/protocol";
import { chunk } from "./fixtures.ts";
import { IndexMirror, chunkKey, keyX, keyY } from "./mirror.ts";
import { FactoryIndex, IndexUnavailableError } from "./service.ts";

type Page = RpcMethods["index_changes"]["result"];
const page = (revision: number, chunks: ChunkSummary[], removed: Page["removed"] = [], more = false): Page => ({ revision, chunks, removed, more });

describe("chunk keys", () => {
  it("round-trips negative and positive coordinates", () => {
    for (const [x, y] of [[0, 0], [-1, -1], [31000, -31000], [-5, 7]] as const) {
      const k = chunkKey(x, y);
      assert.deepEqual([keyX(k), keyY(k)], [x, y]);
    }
  });
});

describe("IndexMirror", () => {
  it("applies chunks, deltas and tombstones", () => {
    const m = new IndexMirror();
    m.apply(page(2, [chunk("nauvis", 0, 0, { revision: 1, crafters: { "iron-gear-wheel": 2 } }), chunk("nauvis", 1, 0, { revision: 2, labs: 4 })]));
    assert.equal(m.chunkCount, 2);
    assert.deepEqual([...m.takeDirty()], ["nauvis"]);

    m.apply(page(4, [chunk("nauvis", 0, 0, { revision: 3, crafters: { "iron-gear-wheel": 5 } })], [{ surface: "nauvis", x: 1, y: 0, revision: 4 }]));
    assert.equal(m.revision, 4);
    assert.equal(m.chunkCount, 1);
    assert.equal(m.surfaces.get("nauvis")!.get(chunkKey(0, 0))!.crafters[0]!.count, 5);

    m.apply(page(5, [], [{ surface: "nauvis", x: 0, y: 0, revision: 5 }]));
    assert.equal(m.surfaces.has("nauvis"), false, "empty surfaces are dropped");
  });

  it("ignores stale summaries and tombstones", () => {
    const m = new IndexMirror();
    m.apply(page(5, [chunk("nauvis", 0, 0, { revision: 5, labs: 1 })]));
    m.apply(page(6, [chunk("nauvis", 0, 0, { revision: 3, labs: 9 })], [{ surface: "nauvis", x: 0, y: 0, revision: 4 }]));
    assert.equal(m.surfaces.get("nauvis")!.get(chunkKey(0, 0))!.labs, 1);
  });

  it("normalises empty Lua tables that arrive as arrays", () => {
    const m = new IndexMirror();
    const raw = { ...chunk("nauvis", 0, 0, { labs: 1 }), entities: [] as unknown as ChunkSummary["entities"] };
    raw.crafters = [{ recipe: "x", machine: "m", count: 1, statuses: [] as unknown as { [s: string]: number } }];
    m.apply(page(1, [raw]));
    const c = m.surfaces.get("nauvis")!.get(chunkKey(0, 0))!;
    assert.deepEqual(c.entities, {});
    assert.equal(c.crafters[0]!.statuses, undefined);
  });

  it("refuses a revision that goes backwards", () => {
    const m = new IndexMirror();
    m.apply(page(10, []));
    assert.throws(() => m.apply(page(3, [])));
  });
});

/** A fake mod serving index_changes from a list of summaries, `limit` at a time. */
function fakeGame(state: { chunks: ChunkSummary[]; removed: Page["removed"]; fail?: string }) {
  const calls: { since: number; limit?: number }[] = [];
  return {
    calls,
    async call(method: string, params: { since: number; limit?: number }) {
      if (state.fail) throw new Error(state.fail);
      if (method === "index_status") return { revision: 0, surfaces: [] };
      calls.push(params);
      const all = [
        ...state.chunks.map((c) => ({ rev: c.revision, chunk: c })),
        ...state.removed.map((r) => ({ rev: r.revision, removed: r })),
      ]
        .filter((e) => e.rev > params.since)
        .sort((a, b) => a.rev - b.rev);
      const slice = all.slice(0, params.limit ?? 500);
      const revision = slice.length > 0 ? slice[slice.length - 1]!.rev : params.since;
      return {
        revision,
        chunks: slice.flatMap((e) => ("chunk" in e ? [e.chunk] : [])),
        removed: slice.flatMap((e) => ("removed" in e ? [e.removed!] : [])),
        more: all.length > slice.length,
      };
    },
  };
}

describe("FactoryIndex refresh", () => {
  it("follows `more` across pages and then pulls only deltas", async () => {
    const state = { chunks: [] as ChunkSummary[], removed: [] as Page["removed"] };
    for (let i = 1; i <= 1200; i++) state.chunks.push(chunk("nauvis", i * 4, 0, { revision: i, crafters: { "iron-plate": 1 } }));
    const game = fakeGame(state);
    const index = new FactoryIndex(game as never);
    await index.refresh(true);
    assert.equal(index.mirror.chunkCount, 1200);
    assert.deepEqual(game.calls.map((c) => c.since), [0, 500, 1000]);
    assert.equal(index.allBlocks().length, 1200);

    state.chunks = [chunk("nauvis", 4, 0, { revision: 1201, crafters: { "iron-plate": 7 } })];
    state.removed = [{ surface: "nauvis", x: 8, y: 0, revision: 1202 }];
    await index.refresh(true);
    assert.equal(game.calls.at(-1)!.since, 1200);
    assert.equal(index.mirror.chunkCount, 1199);
    assert.equal(index.allBlocks().find((b) => b.chunks.includes(chunkKey(4, 0)))!.machines, 7);
  });

  it("throttles refreshes and resets when the mod's index goes backwards", async () => {
    const state = { chunks: [chunk("nauvis", 0, 0, { revision: 50, labs: 1 })], removed: [] as Page["removed"] };
    const game = fakeGame(state);
    const index = new FactoryIndex(game as never);
    await index.refresh();
    await index.refresh();
    assert.equal(game.calls.length, 1, "second refresh within the throttle window is skipped");

    // New save / rebuilt index: revisions restart.
    state.chunks = [chunk("nauvis", 5, 5, { revision: 2, labs: 1 })];
    const realCall = game.call;
    let first = true;
    game.call = async (method, params) => {
      if (first && method === "index_changes") {
        first = false;
        return { revision: 2, chunks: [], removed: [], more: false };
      }
      return realCall(method, params);
    };
    await index.refresh(true);
    assert.equal(index.mirror.chunkCount, 1);
    assert.ok(index.mirror.surfaces.get("nauvis")!.has(chunkKey(5, 5)));
  });

  it("reports an unavailable index clearly", async () => {
    const game = fakeGame({ chunks: [], removed: [], fail: "The factory index is not implemented yet" });
    const index = new FactoryIndex(game as never);
    await assert.rejects(index.search({ item: "iron-plate" }), (err: Error) => err instanceof IndexUnavailableError && /unavailable.*not implemented/.test(err.message));
    // Not cached as success: still failing on the next call.
    await assert.rejects(index.overview(), IndexUnavailableError);
  });
});
