-- Builds a small test factory on Nauvis with known, deliberate problems, so the helper has
-- something real to observe and diagnose. Test fixture only: it uses script-only entities
-- (infinity chests, electric energy interfaces) that the helper itself must never use.
--
-- Sections (all east of spawn, inside one radar's live coverage):
--   A  Green circuits, working       4 direct-insertion lines (2 cable : 1 circuit), plates in, void out
--   B  Gears, output blocked         output chest pre-filled with gears
--   C  Red circuits, starved         plastic input chest is empty
--   D  Belt smelting, under-supplied 1 basic inserter feeds a belt for 6 electric furnaces
--   E  Low power island              separate grid, 100 kW for ~500 kW of machines

local FORCE = "player"

local RESEARCH = {
  "automation-2", "electronics", "logistics-2", "fast-inserter", "steel-processing",
  "advanced-material-processing-2", "oil-processing", "plastics", "advanced-circuit",
  "electric-energy-distribution-2", "electric-mining-drill", "radar",
}

local function research(force, name)
  local tech = force.technologies[name]
  if not tech or tech.researched then return end
  for prerequisite in pairs(tech.prerequisites) do research(force, prerequisite) end
  tech.researched = true
end

local function prepare_area(surface, area)
  surface.request_to_generate_chunks({ x = 40, y = 15 }, 4)
  surface.force_generate_chunk_requests()
  for _, e in pairs(surface.find_entities_filtered({ area = area })) do
    if e.valid and e.type ~= "character" then e.destroy() end
  end
  local tiles = {}
  for x = area[1][1], area[2][1] - 1 do
    for y = area[1][2], area[2][2] - 1 do
      tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } }
    end
  end
  surface.set_tiles(tiles)
end

local function create(surface, name, position, extra)
  local params = { name = name, position = position, force = FORCE }
  for k, v in pairs(extra or {}) do params[k] = v end
  local entity = surface.create_entity(params)
  if not entity then error("Could not create " .. name .. " at " .. serpent.line(position)) end
  return entity
end

--- Inserter at `position` that drops towards `to` (picks direction by checking drop_position).
local function inserter(surface, position, to, name)
  local entity = create(surface, name or "inserter", position)
  local best, best_distance
  for _, direction in pairs({ defines.direction.north, defines.direction.east, defines.direction.south, defines.direction.west }) do
    entity.direction = direction
    local drop = entity.drop_position
    local distance = (drop.x - to[1]) ^ 2 + (drop.y - to[2]) ^ 2
    if not best or distance < best_distance then best, best_distance = direction, distance end
  end
  entity.direction = best
  return entity
end

local function source(surface, position, item, count)
  local chest = create(surface, "infinity-chest", position)
  chest.set_infinity_container_filter(1, { name = item, count = count or 100, mode = "exactly" })
  return chest
end

local function sink(surface, position)
  local chest = create(surface, "infinity-chest", position)
  chest.remove_unfiltered_items = true
  return chest
end

local function assembler(surface, position, recipe)
  local entity = create(surface, "assembling-machine-2", position)
  entity.set_recipe(recipe)
  return entity
end

local function label(surface, position, text)
  rendering.draw_text({ text = text, surface = surface, target = position, color = { 1, 0.8, 0.2 }, scale = 1.5 })
end

local function power(surface)
  local interface = create(surface, "electric-energy-interface", { 6, 0 })
  interface.power_production = 100e6 / 60
  interface.electric_buffer_size = 100e6 / 60
  for _, x in pairs({ 8, 26, 42 }) do
    for _, y in pairs({ -36, -20, -4, 12, 28 }) do create(surface, "substation", { x, y }) end
  end
  create(surface, "radar", { 44, 2 })
end

local function green_circuits(surface)
  label(surface, { 10, -35 }, "A: green circuits (working)")
  for row = 0, 3 do
    local y = -29.5 + row * 7
    -- cable assembler | circuit assembler | cable assembler, iron from above, output below
    source(surface, { 10.5, y }, "copper-plate")
    inserter(surface, { 11.5, y }, { 13.5, y })
    assembler(surface, { 13.5, y }, "copper-cable")
    inserter(surface, { 15.5, y }, { 17.5, y }, "fast-inserter")
    assembler(surface, { 17.5, y }, "electronic-circuit")
    inserter(surface, { 19.5, y }, { 17.5, y }, "fast-inserter")
    assembler(surface, { 21.5, y }, "copper-cable")
    inserter(surface, { 23.5, y }, { 21.5, y })
    source(surface, { 24.5, y }, "copper-plate")
    source(surface, { 17.5, y - 3 }, "iron-plate")
    inserter(surface, { 17.5, y - 2 }, { 17.5, y })
    inserter(surface, { 17.5, y + 2 }, { 17.5, y + 3 })
    sink(surface, { 17.5, y + 3 })
  end
end

local function blocked_gears(surface)
  label(surface, { 10, -5 }, "B: gears (output blocked)")
  local y = -2.5
  source(surface, { 10.5, y }, "iron-plate")
  inserter(surface, { 11.5, y }, { 13.5, y })
  assembler(surface, { 13.5, y }, "iron-gear-wheel")
  inserter(surface, { 15.5, y }, { 16.5, y })
  local chest = create(surface, "wooden-chest", { 16.5, y })
  chest.insert({ name = "iron-gear-wheel", count = 1600 })
end

local function starved_red_circuits(surface)
  label(surface, { 10, 1 }, "C: red circuits (starved)")
  local y = 5.5
  source(surface, { 10.5, y }, "electronic-circuit")
  inserter(surface, { 11.5, y }, { 13.5, y })
  assembler(surface, { 13.5, y }, "advanced-circuit")
  source(surface, { 13.5, y - 3 }, "copper-cable")
  inserter(surface, { 13.5, y - 2 }, { 13.5, y })
  create(surface, "wooden-chest", { 13.5, y + 3 }) -- plastic should come from here, but it's empty
  inserter(surface, { 13.5, y + 2 }, { 13.5, y })
  inserter(surface, { 15.5, y }, { 16.5, y })
  sink(surface, { 16.5, y })
end

local function belt_smelting(surface)
  label(surface, { 29, -35 }, "D: belt smelting (under-supplied)")
  source(surface, { 30.5, -31.5 }, "iron-ore")
  inserter(surface, { 30.5, -30.5 }, { 30.5, -29.5 })
  for y = -29.5, -4.5 do
    create(surface, "transport-belt", { 30.5, y }, { direction = defines.direction.south })
  end
  for i = 0, 5 do
    local y = -26.5 + i * 4
    inserter(surface, { 31.5, y }, { 33.5, y })
    create(surface, "electric-furnace", { 33.5, y })
    inserter(surface, { 35.5, y }, { 36.5, y })
    sink(surface, { 36.5, y })
  end
end

local function low_power(surface)
  label(surface, { 12, 55 }, "E: low power island")
  local interface = create(surface, "electric-energy-interface", { 12, 60 })
  interface.power_production = 100e3 / 60
  interface.electric_buffer_size = 100e3 / 60
  create(surface, "substation", { 19, 59 })
  create(surface, "substation", { 31, 59 })
  for i = 0, 2 do
    local x = 16 + i * 6
    source(surface, { x + 0.5, 62.5 }, "iron-plate")
    inserter(surface, { x + 1.5, 62.5 }, { x + 3.5, 62.5 })
    assembler(surface, { x + 3.5, 62.5 }, "iron-gear-wheel")
    inserter(surface, { x + 3.5, 64.5 }, { x + 3.5, 65.5 })
    sink(surface, { x + 3.5, 65.5 })
  end
end

local function build()
  local surface = game.surfaces.nauvis
  local force = game.forces[FORCE]
  for _, name in pairs(RESEARCH) do research(force, name) end
  force.inserter_stack_size_bonus = 2 -- as from inserter capacity research; keeps direct insertion flowing
  prepare_area(surface, { { 0, -45 }, { 80, 75 } })
  power(surface)
  green_circuits(surface)
  blocked_gears(surface)
  starved_red_circuits(surface)
  belt_smelting(surface)
  low_power(surface)
end

return {
  on_init = function()
    remote.call("freeplay", "set_skip_intro", true)
    remote.call("freeplay", "set_disable_crashsite", true)
    build()
  end,
}
