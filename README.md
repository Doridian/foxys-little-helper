# Foxie's Little Helper

An LLM-driven helper for Factorio 2.0 that plays by the same rules you do.

Ask it things in chat ("flh, why is our green chip factory on gleba stuck?") and it investigates
the factory through the same information a player has, and (later) acts through a physical body:
ghosts + construction bots, then an "LLM control" equipment module that makes a spidertron (or
other vehicle) inhabitable by the helper.

## Ground rules

**The helper never cheats.** No teleporting, no spawning items, no peeking at uncharted areas.
The mod enforces this, not the prompt:

- Map-level knowledge is limited to chunks the force has charted.
- Live entity details (status, inventories, belts...) require the chunk to be currently visible
  (radar coverage or a player nearby), like remote view.
- Future action tools will consume real items, respect reach and move bodies physically.

## Architecture

```
Factorio headless server                      Bridge (Node, same host)
┌─────────────────────────────────┐   RCON   ┌──────────────────────────────────┐
│ mod: foxies-little-helper       │◄────────►│ RPC client (/flh-rpc <json>)     │
│  /flh, "flh," chat -> event queue│          │ poll_events every 250ms          │
│  /flh-rpc (RCON only) -> queries│          │ per-player conversations         │
│  fairness checks                │          │ Claude tool runner + tools       │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

| Package | What |
|---|---|
| `packages/protocol` | Type-only RPC definitions shared by both sides |
| `packages/mod` | The Factorio mod, TypeScript compiled to Lua with TypeScriptToLua + typed-factorio (2.0 line) |
| `packages/bridge` | Node process: RCON client, Claude agent loop, tool definitions, production planner |

The LLM only gets the tools defined in `packages/bridge/src/tools.ts`, with no shell or file
access, since any player on the server can talk to it.

## Development

```sh
npm install
npm run dev-server        # builds the mod, runs an isolated headless server in ./dev (RCON 27015, password flh-dev)
```

By default the dev server starts a fresh copy of the `flh-demo` scenario
([scripts/scenarios/flh-demo](scripts/scenarios/flh-demo/demo-factory.lua)) every time: freeplay
with mid-game research and a small scripted test factory east of spawn, with known problems for the
helper to find:

| Section | Expected state |
|---|---|
| A: green circuits | Working, ~360/min from 4 direct-insertion lines |
| B: gears | `full_output`: output chest is full |
| C: red circuits | `item_ingredient_shortage`: plastic chest is empty |
| D: belt smelting | 2 of 6 furnaces idle: one inserter can't supply the belt |
| E: low power island | `low_power`: separate grid with 100 kW for ~500 kW of load |
| F: robot network | Roboport, 50 construction robots, storage chest with building materials; covers the free space east of the demo, so approved builds get built |

The fixture uses script-only entities (infinity chests, energy interfaces) to stay small; the
helper itself never gets such powers.

For scale and performance testing, `FLH_SCENARIO=flh-megabase` builds a ~265k entity factory of
48 production blocks (mines, smelting, oil, circuits, science, labs, trains, robots) with ten
broken blocks whose causes are known; see [its README](scripts/scenarios/flh-megabase/README.md). Set `FLH_SCENARIO=` (empty) to play a persistent save instead
(`FLH_SAVE`, default `dev/saves/dev.zip`). Handy for testing without a client: after someone has
joined once (so the map is charted), `/server-save <name>` over RCON and restart with
`FLH_SCENARIO= FLH_SAVE=dev/data/saves/<name>.zip`.

In another terminal:

```sh
export ANTHROPIC_API_KEY=...
FLH_RCON_PASSWORD=flh-dev npm run bridge
```

Then connect your Factorio client to `localhost` and type `flh, hello` or `/flh hello` in chat.
`/flh stop` cancels the current request.

Dev tools:

```sh
npm run rcon -w @flh/bridge -- '/c rcon.print(game.tick)'   # one-off console command
npm run smoke-test -w @flh/bridge                            # calls every RPC against the demo world (read-only)
npm test -w @flh/bridge                                      # planner unit tests
npm run transcript -w @flh/bridge -- 10                      # last 10 conversations, with tool calls
npm run ask -w @flh/bridge -- "what's broken?"               # headless: one request through the real agent (costs tokens)
npm run ask -w @flh/bridge -- --turns "what's broken?" "fix C"  # several messages in one conversation
npm run rcon -w @flh/bridge -- '/flh-rpc-profile {"method":"find_entities","params":{...},"runs":5}'  # time one RPC
```

Every RPC runs inside a single game tick, so each one is bounded to stay in the tens of
milliseconds even on a megabase: entity queries cover at most 512x512 tiles (radius 256) and
look at most at 5000 entities, designs have at most 1500 entities, and whole-surface scans are
refused in favour of the factory index. The limits live at the top of
[queries.ts](packages/mod/src/queries.ts) (and in the tool descriptions).

Several dev servers can run side by side (e.g. one per git worktree) with `FLH_DEV_DIR`,
`FLH_GAME_PORT` and `FLH_RCON_PORT`. `FLH_DEV_FOG_OFF=1` additionally loads the test-only
`flh-dev` mod ([scripts/dev-mods](scripts/dev-mods/flh-dev/info.json)), which lifts fog of war
for the helper so automated tests work on worlds nobody has joined. Never use it for real games.

The bridge logs every conversation (player messages, replies, tool calls and results, token
usage, errors) to `dev/transcripts/<date>.jsonl` (`FLH_TRANSCRIPT_DIR` to change).

To test with your normal client, symlink the build into your mods folder (the server and client
then load the same files):

```sh
ln -s "$PWD/packages/mod/build/foxies-little-helper" ~/.factorio/mods/foxies-little-helper
```

### Bridge configuration

| Env var | Default |
|---|---|
| `FLH_RCON_HOST` / `FLH_RCON_PORT` / `FLH_RCON_PASSWORD` | `127.0.0.1` / `27015` / required |
| `FLH_MODEL` | `claude-opus-5-5` |
| `FLH_EFFORT` | `medium` |
| `FLH_MAX_ITERATIONS` | `40` |
| `FLH_POLL_MS` | `250` |
| `FLH_CLEAR_TRIGGER_TOKENS` / `FLH_CLEAR_KEEP` / `FLH_CLEAR_AT_LEAST_TOKENS` | `100000` / `10` / `30000` (server-side clearing of old tool results) |
| `FLH_COMPACT_AFTER_TOKENS` / `FLH_COMPACT_DURING_TOKENS` | `50000` / `200000` (server-side compaction after / during a request) |

### Conversation context

Each player's conversation is kept append-only by the bridge: the model's thinking is bound to the
exact history before it, so the bridge never trims or rewrites earlier turns. Context stays small
through the API instead ([context.ts](packages/bridge/src/context.ts)): tool results are capped at
24k characters when they are made (a bigger result becomes an error asking for a narrower query),
the server clears old tool results inside very long requests, and once a request is done a
conversation over the threshold is compacted into a summary. The transcript shows clearing and
compactions on the usage lines.

### Factory index

Big bases are never put into context wholesale. The mod keeps a summary per chunk of the force's
buildings ([factory-index.ts](packages/mod/src/factory-index.ts)): machines by recipe, drills by
resource, labs, train stops and other entities, with live statuses when the chunk is visible.
Build and removal events mark chunks for a refresh, and a background pass re-summarises
everything (statuses, recipe changes) while a slow sweep finds entities that scripts created
without events. The work per tick is capped by the map setting `flh-index-chunks-per-tick`
(default 3, weighted by chunk density; 0 pauses it), about 0.3 ms per tick on a dense base.

The bridge mirrors the index through `index_changes` (only what changed since the last pull) and
groups chunks into production blocks ([factory/](packages/bridge/src/factory/)). The helper then
works top down: `factory_overview` and `search_factory` ("where do we make blue circuits?",
"what's broken?", station and place names), `describe_block`, and only then live queries on the
problem areas. On the `flh-megabase` scenario (265k entities, 1008 chunks), the first sync takes
about 70 ms, a search 5-15 ms, and "what's broken?" is answered in 10 model calls with about 40k
tokens of context.

### Gotchas

- With **no players connected**, the server does not process chart requests (radars and
  `force.chart` queue up but nothing gets charted), so the helper's view of the map is frozen
  until someone joins. The dev server also disables `auto_pause` so the game keeps ticking.
- Lua can't tell empty arrays from empty objects; the bridge turns `{}` from the mod back into `[]`.

## In game

- Talk to it with `flh, ...` in chat, `/flh ...`, or the ask window (shortcut bar button,
  Ctrl+Shift+H, or plain `/flh`), which has a multi-line input and your conversation history.
- A panel (top left) shows your request while it is being worked on, what the helper is doing,
  and a Stop button.
- The area tool (shortcut bar) marks an area: "build here", "copy this", "what's wrong in here".
- Builds are always proposed first: you see a preview (red where blocked) and choose Build
  (ghosts for your robots), Blueprint (into your cursor to place yourself) or Reject in the panel,
  or answer in chat.
- Name things: "call this the iron bus" (with an area marked, or about what you were just
  discussing) and the helper remembers it for everyone on the force, saved with the game. It also
  knows your map tags, so "what's wrong at the gleba science tag?" works.

### Designs

The helper can build from:

- **In-game blueprints**: blueprints/books in chests you register ("use the chest I marked as
  your library") and in your inventory. Mods can't read the personal blueprint library.
- **Repo blueprints**: exchange strings in [blueprints/](blueprints/README.md), one per `.txt`.
- **Public blueprints** from [factorioprints.com](https://factorioprints.com): the helper searches
  titles (and site tags), fetches a blueprint or book, and can preview any page of it or hand you
  the whole book. Pre-2.0 strings are converted on import; entities from mods you don't have are
  reported and dropped. Titles and descriptions are treated as untrusted text. Turn it off with
  `FLH_PUBLIC_BLUEPRINTS=0`.
- **Copies** of a working section of your factory.
- **Generated layouts**: `assembler_row` (N machines between an input and an output belt) for now.

Script-only entities (infinity chests etc.) are stripped from any design. Other actions: mark
for deconstruction, change recipes, find free space, and undo (removes unbuilt ghosts, orders
deconstruction of built ones, cancels deconstruction, restores recipes).

## Production planner

`plan_production` (in `packages/bridge/src/planner/`) turns "N items/min of X on surface S" into
recipe steps, machine counts, power, raw inputs, mining drills and byproducts, then compares it with
live production stats and existing machines on that surface. The LLM picks the goal and options;
the numbers come from deterministic code working on prototype data exported by the mod.

- Uses only researched recipes and machines by default (`allow_locked` to look ahead), picking the
  best researched machine per recipe, or the most basic one when none is researched yet.
- Knows each planet: surface conditions, and which resources and tile fluids (water, lava...) its map
  generation places. Raw resources available locally are mined/pumped; elsewhere recipes are chosen
  that work with what is there (molten iron from lava on Vulcanus, scrap recycling on Fulgora,
  asteroid crushing on platforms).
- Modules, beacons (with the 2.0 beacon profile), recipe productivity research and mining
  productivity are applied.
- Byproducts are credited greedily and steps sharing a recipe are merged, so a multi-output recipe
  is sized once. It is not a full LP optimiser (it won't balance cracking for you), spoilage is not
  modelled (it says when an item comes from spoiling), and quality is ignored.

## Roadmap

1. **Observe** (done): game info, production rates, status summaries, entity inspection.
2. **Plan** (done): ratio solver from prototype data, gap analysis ("you make 62/min, need 100").
3. **Act via remote view** (now): blueprint sources, site finder, ghost placement with in-game
   preview and approval, deconstruction, recipes, undo. Bots do the building. Next: more layout
   generators (fluids, smelting columns, direct insertion), connecting new builds to inputs.
4. **Embodiment**: an "LLM control" equipment-grid item that lets the helper drive a spidertron
   (autopilot, personal roboport, inventory) and possibly other vehicles.
