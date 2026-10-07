# flh-megabase: scale test world

Freeplay plus a large scripted factory on Nauvis ([megabase.lua](megabase.lua)), for testing how
the helper and the mod behave on a big base. Like flh-demo it uses script-only entities (infinity
chests and pipes, loaders, electric energy interfaces) to stay compact; the helper never gets those.

```sh
FLH_SCENARIO=flh-megabase FLH_DEV_FOG_OFF=1 npm run dev-server
```

`FLH_DEV_FOG_OFF=1` matters: nobody has joined, so nothing is charted otherwise. Generation runs
one block per tick after start (about 12 s); wait for it before testing:

```sh
npm run rcon -w @flh/bridge -- '/c rcon.print(serpent.line(remote.call("flh-megabase", "status")))'
# {chunks = 2246, done = true, done_tick = 50, entities = 264570, progress = "51/51", used_chunks = 1008}
npm run rcon -w @flh/bridge -- '/c rcon.print(helpers.table_to_json(remote.call("flh-megabase", "blocks")))'
```

Restarting the scenario regenerates the world each time; for quicker restarts save it once
(`/server-save megabase`) and load it with `FLH_SCENARIO= FLH_SAVE=dev/data/saves/megabase.zip`.

## Measurements

On a Ryzen 9 7940HS (Factorio 2.0.77, Space Age enabled), with other servers running alongside:

| | |
|---|---|
| Entities of the player force | 264,570 (deterministic) |
| Chunks with player entities / generated | 1,008 / ~2,250 |
| Generation | ~12 s (script time 11-12 s, spread over 51 ticks) |
| Save size | 8.8 MB |
| Idle tick time | ~11 ms (about 90 UPS at `game.speed = 100`), so it runs at 60 UPS with some headroom |

Research is everything finite that needs only Nauvis science packs; the labs research
`follower-robot-count-5` (infinite), re-queued whenever a level finishes.

## Layout

Blocks are 128x128 tiles on a 160 tile grid (32 tile streets), 8 columns by 6 rows. Block (col,
row) starts at x = 168 + 160 col, y = -472 + 160 row, so the factory covers x 168..1416,
y -472..456, east of spawn. Blocks are deliberately not chunk aligned. Each block is its own
electric grid (energy interface just above its top-left corner, substations in the gaps between
segments of 5 machines). Production lines are rows of machines between belts fed by loaders from
infinity chests, with outputs voided at the end of each segment.

Streets:

- y -328 (between rows 0 and 1): 26 roboports, each with 25 construction and 25 logistic robots,
  and 4 storage chests (one stocked with building materials) at x 182..186, y -324.
- y -7 (between rows 2 and 3): an east-west rail line with train stops `Iron Ore Drop` (x 231),
  `Copper Ore Drop` (391), `Coal Pickup` (551), `Plastic Pickup` (711), `Circuit Pickup` (871),
  `Science Drop` (1031) and `Depot` (1191), all at y -5. Parked trains (locomotive + 2 cargo
  wagons, manual mode) at Iron Ore Drop, Circuit Pickup and Depot.

## Blocks and seeded problems

Top-left corner of each 128x128 block; the state is what status_summary over the block shows for
its machines (all of them, after a minute or so of running).

| Block | Top-left | Makes | Expected state |
|---|---|---|---|
| Iron mine 1 | (168, -472) | iron-ore (1080 drills) | working |
| Iron mine 2 | (328, -472) | iron-ore | working |
| Copper mine | (488, -472) | copper-ore | working |
| Coal mine | (648, -472) | coal | working |
| **Stone mine (depleted)** | (808, -472) | - | `no_minable_resources`: drills, belts and power, but no ore under them |
| Oil field | (968, -472) | crude-oil (625 pumpjacks) | working |
| Oil refinery | (1128, -472) | advanced-oil-processing | working |
| **Oil refinery 2** | (1288, -472) | advanced-oil-processing | `full_output`: heavy oil outputs are not connected to anything |
| Iron smelting 1 | (168, -312) | iron-plate (540 electric furnaces) | working |
| Iron smelting 2 | (328, -312) | iron-plate | working |
| Copper smelting 1 | (488, -312) | copper-plate | working |
| Copper smelting 2 | (648, -312) | copper-plate | working |
| Steel smelting | (808, -312) | steel-plate | working |
| Stone bricks | (968, -312) | stone-brick | working |
| Plastic | (1128, -312) | plastic-bar (chemical plants) | working |
| Sulfur | (1288, -312) | sulfur | working |
| Gears | (168, -152) | iron-gear-wheel | working |
| **Gears 2** | (328, -152) | iron-gear-wheel | `full_output`: output belts end in nothing and are backed up |
| Pipes | (488, -152) | pipe | working |
| Copper cable | (648, -152) | copper-cable (assembling machine 2) | working |
| **Copper cable 2** | (808, -152) | copper-cable (assembling machine 2) | `low_power`: own grid with 40 MW for ~90 MW of machines |
| Sulfuric acid | (968, -152) | sulfuric-acid | working |
| Lubricant | (1128, -152) | lubricant | working |
| **Spare assemblers** | (1288, -152) | - | `no_recipe`: assemblers (with belts and inserters) never given a recipe |
| Green circuits 1 | (168, 8) | electronic-circuit | working |
| Green circuits 2 | (328, 8) | electronic-circuit | working |
| **Green circuits 3** | (488, 8) | electronic-circuit | `no_power`: substations not connected to any power source |
| Red circuits 1 | (648, 8) | advanced-circuit | working |
| **Red circuits 2** | (808, 8) | advanced-circuit | `item_ingredient_shortage`: plastic supply (C belts, bottom) is empty |
| Blue circuits 1 | (968, 8) | processing-unit | working |
| **Blue circuits 2** | (1128, 8) | processing-unit | `fluid_ingredient_shortage`: sulfuric acid pipes are empty |
| Low density structures | (1288, 8) | low-density-structure | working |
| Engines 1 | (168, 168) | engine-unit | working |
| **Engines 2** | (328, 168) | engine-unit | `item_ingredient_shortage`: no gear belt or gear inserters were ever built |
| Electric engines | (488, 168) | electric-engine-unit | working |
| Red science | (648, 168) | automation-science-pack | working |
| Green science | (808, 168) | logistic-science-pack | working |
| Blue science | (968, 168) | chemical-science-pack | working |
| Military science | (1128, 168) | military-science-pack | working |
| Purple science | (1288, 168) | production-science-pack | working |
| Yellow science | (168, 328) | utility-science-pack | working |
| Labs 1 | (328, 328) | research (540 labs) | working |
| Labs 2 | (488, 328) | research | working |
| **Labs 3** | (648, 328) | research | `missing_science_packs`: supply chests have no utility science packs |
| Green circuits 4 | (808, 328) | electronic-circuit | working |
| Iron smelting 3 | (968, 328) | iron-plate | working |
| Gears 3 | (1128, 328) | iron-gear-wheel | working |
| Copper smelting 3 | (1288, 328) | copper-plate | working |
