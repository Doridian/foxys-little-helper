// Dev smoke test: sets up a tiny factory on a dev server via /c (test fixture only, never used by
// the helper itself) and exercises every RPC.
import { GameClient } from "./game.ts";
import { Rcon } from "./rcon.ts";

const rcon = new Rcon("127.0.0.1", Number(process.env.FLH_RCON_PORT ?? 27015), process.env.FLH_RCON_PASSWORD ?? "flh-dev");
await rcon.connect();
const game = new GameClient(rcon);

await rcon.exec(`/c local s = game.surfaces.nauvis
for _, e in pairs(s.find_entities_filtered{area={{-20,-20},{20,20}}}) do if e.type ~= "character" then e.destroy() end end
s.create_entity{name="electric-energy-interface", position={0,0}, force="player"}
s.create_entity{name="substation", position={3,0}, force="player"}
s.create_entity{name="radar", position={6,-4}, force="player"}
local a = s.create_entity{name="assembling-machine-2", position={6,2}, force="player"}
a.set_recipe("electronic-circuit")
a.insert{name="iron-plate", count=10}`);
await new Promise((r) => setTimeout(r, 3000));

const show = async (label: string, p: Promise<unknown>) => {
  try { console.log(label, JSON.stringify(await p, null, 1).slice(0, 1500)); }
  catch (e) { console.log(label, "ERROR:", (e as Error).message); }
};
await show("game_info", game.call("game_info", {}));
await show("production", game.call("production", { surface: "nauvis", window: "1m" }));
await show("status_summary", game.call("status_summary", { surface: "nauvis", area: { left_top: { x: -20, y: -20 }, right_bottom: { x: 20, y: 20 } } }));
await show("find_entities", game.call("find_entities", { surface: "nauvis", type: "assembling-machine" }));
await show("inspect_entity", game.call("inspect_entity", { surface: "nauvis", position: { x: 6.5, y: 2.5 }, name: "assembling-machine-2" }));
await show("not_visible", game.call("inspect_entity", { surface: "nauvis", position: { x: 5000, y: 5000 } }));
await show("bad_surface", game.call("production", { surface: "gleba", window: "1m" }));
await show("poll_events", game.call("poll_events", {}));
await show("say", game.call("say", { message: "hello from the smoke test" }));
rcon.close();
