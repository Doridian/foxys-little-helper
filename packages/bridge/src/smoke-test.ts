// Dev smoke test: calls every RPC against the flh-demo scenario world (see scripts/scenarios).
// Read-only. Live queries need a player to have joined at least once, or nothing is charted.
import { GameClient } from "./game.ts";
import { Rcon } from "./rcon.ts";

const rcon = new Rcon("127.0.0.1", Number(process.env.FLH_RCON_PORT ?? 27015), process.env.FLH_RCON_PASSWORD ?? "flh-dev");
await rcon.connect();
const game = new GameClient(rcon);

const show = async (label: string, p: Promise<unknown>) => {
  try { console.log(label, JSON.stringify(await p, null, 1).slice(0, 1500)); }
  catch (e) { console.log(label, "ERROR:", (e as Error).message); }
};
await show("game_info", game.call("game_info", {}));
await show("production", game.call("production", { surface: "nauvis", window: "1m" }));
const demo = { left_top: { x: 0, y: -45 }, right_bottom: { x: 80, y: 75 } };
await show("status_summary", game.call("status_summary", { surface: "nauvis", area: demo, type: ["assembling-machine", "furnace"] }));
await show("find_entities", game.call("find_entities", { surface: "nauvis", area: demo, type: "assembling-machine" }));
await show("whole_surface", game.call("find_entities", { surface: "nauvis", type: "assembling-machine" }));
await show("inspect_entity", game.call("inspect_entity", { surface: "nauvis", position: { x: 13.5, y: 5.5 }, name: "assembling-machine-2" }));
await show("inspect_inserter", game.call("inspect_entity", { surface: "nauvis", position: { x: 13.5, y: 7.5 }, name: "inserter" }));
await show("production_mixed", game.call("production", { surface: "nauvis", window: "1m", items: ["electronic-circuit", "petroleum-gas"] }));
await show("not_visible", game.call("inspect_entity", { surface: "nauvis", position: { x: 5000, y: 5000 } }));
await show("bad_surface", game.call("production", { surface: "gleba", window: "1m" }));
await show("force_recipes", game.call("force_recipes", {}).then((f) => ({ ...f, enabled_recipes: f.enabled_recipes.length })));
await show("surface_info", game.call("surface_info", { surface: "vulcanus" }));
await show("prototypes", game.call("prototypes", {}).then((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.length]))));
await show("list_places", game.call("list_places", {}));
await show("poll_events", game.call("poll_events", {}));
await show("say", game.call("say", { message: "hello from the smoke test" }));
rcon.close();
