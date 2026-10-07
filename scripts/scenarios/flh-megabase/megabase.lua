-- Builds a large scripted factory on Nauvis for scale and performance testing: ~45 production
-- blocks of 128x128 tiles on a grid, a few hundred thousand entities of the player force, with a
-- handful of deliberately broken blocks whose causes are known (see README.md next to this file).
-- Test fixture only: it uses script-only entities (infinity chests and pipes, loaders, electric
-- energy interfaces) that the helper itself must never use.
--
-- Generation is deterministic (fixed block list, fixed build order, terrain under the factory is
-- replaced) and spread over ticks, one block per tick, so on_init stays short (~12 s in total;
-- the script time is logged). remote.call("flh-megabase", "status") says when it is done and
-- counts entities and chunks; remote.call("flh-megabase", "blocks") lists every block with its
-- area and expected state.

local FORCE = "player"
local CELL = 128 -- block size in tiles
local PITCH = 160 -- block pitch: 32 tile streets between blocks
-- Top-left of block (0, 0). Deliberately not chunk aligned, so blocks straddle chunk borders.
local ORIGIN = { x = 168, y = -472 }
local POWER = 2e9 -- W per block grid: plenty
local RESEARCH = "follower-robot-count-5" -- infinite, needs all seven Nauvis science packs

local N, E, S = defines.direction.north, defines.direction.east, defines.direction.south
local surface -- set when generation starts

local function research(force, name)
  local tech = force.technologies[name]
  if not tech or tech.researched then return end
  for prerequisite in pairs(tech.prerequisites) do research(force, prerequisite) end
  tech.researched = true
end

--- Everything a late-game Nauvis base has: all finite techs using only Nauvis science packs.
local NAUVIS_PACKS = {
  ["automation-science-pack"] = true, ["logistic-science-pack"] = true, ["military-science-pack"] = true,
  ["chemical-science-pack"] = true, ["production-science-pack"] = true, ["utility-science-pack"] = true,
  ["space-science-pack"] = true,
}
local function research_nauvis(force)
  local names = {}
  for name, tech in pairs(prototypes.technology) do
    local ok = #tech.research_unit_ingredients > 0 and tech.max_level < 1000
    for _, ingredient in pairs(tech.research_unit_ingredients) do
      if not NAUVIS_PACKS[ingredient.name] then ok = false end
    end
    if ok then names[#names + 1] = name end
  end
  table.sort(names) -- pairs() order is deterministic in Factorio, but be explicit
  for _, name in pairs(names) do research(force, name) end
end

local function create(name, x, y, direction)
  local entity = surface.create_entity({ name = name, position = { x, y }, force = FORCE, direction = direction })
  if not entity then error("Could not create " .. name .. " at " .. x .. "," .. y) end
  return entity
end

local function source(x, y, items)
  local chest = create("infinity-chest", x, y)
  if type(items) == "string" then items = { items } end
  for i, item in pairs(items or {}) do
    chest.set_infinity_container_filter(i, { name = item, count = 50, mode = "exactly" })
  end
  return chest
end

local function sink(x, y)
  local chest = create("infinity-chest", x, y)
  chest.remove_unfiltered_items = true
  return chest
end

local function substation(x, y) create("substation", x, y) end

local function power(x, y, watts)
  local interface = create("electric-energy-interface", x, y)
  interface.power_production = watts / 60
  interface.electric_buffer_size = watts / 60
end

local function label(x, y, text)
  rendering.draw_text({ text = text, surface = surface, target = { x, y }, color = { 1, 0.8, 0.2 }, scale = 6 })
end

--- Belt of `length` tiles flowing east from x, fed by a loader from an infinity chest at its west end.
local function feed_belt(x, y, length, belt, item, starved)
  source(x - 2.5, y + 0.5, (not starved) and item or nil)
  surface.create_entity({ name = "express-loader", position = { x - 1, y + 0.5 }, force = FORCE, direction = E, type = "output" })
  for i = 0, length - 1 do create(belt, x + i + 0.5, y + 0.5, E) end
end

--- Belt of `length` tiles flowing east from x into a loader and void chest (or a dead end).
local function output_belt(x, y, length, belt, blocked)
  for i = 0, length - 1 do create(belt, x + i + 0.5, y + 0.5, E) end
  if blocked then return end
  surface.create_entity({ name = "express-loader", position = { x + length + 1, y + 0.5 }, force = FORCE, direction = E, type = "input" })
  sink(x + length + 2.5, y + 0.5)
end

--- Infinity pipes on every fluid connection of a machine: inputs filled, outputs voided.
local function connect_fluids(entity, spec)
  local fluidbox = entity.fluidbox
  for i = 1, #fluidbox do
    -- Pumpjacks have no filter: they output whatever they mine.
    local fluid = fluidbox.get_filter(i) or (entity.type == "mining-drill" and { name = "crude-oil" }) or nil
    local prototype = fluidbox.get_prototype(i)
    if prototype.object_name ~= "LuaFluidBoxPrototype" then prototype = prototype[1] end
    if fluid then
      local input = prototype.production_type == "input"
      local name = fluid.name
      for _, connection in pairs(fluidbox.get_pipe_connections(i)) do
        local p = connection.target_position
        if surface.count_entities_filtered({ position = p, radius = 0.3 }) > 0 then
          error(entity.name .. " fluid port at " .. p.x .. "," .. p.y .. " is blocked")
        end
        if input or spec.fluid_blocked ~= name then
          local pipe = create("infinity-pipe", p.x, p.y)
          if input then
            if spec.fluid_starved ~= name then pipe.set_infinity_pipe_filter({ name = name, percentage = 1, mode = "at-least" }) end
          else
            pipe.set_infinity_pipe_filter({ name = name, percentage = 0, mode = "exactly" })
          end
        end
      end
    end
  end
end

-- ---- Block builders. Each gets the block's top-left corner and its spec. ----

--[[
Production line block: rows of machines, `per_segment` machines per segment between 3 tile wide
gaps (input chests + loaders, output loader + void chest, substations). Row layout, top to bottom:
  [B belt]  only if some slot uses B (long-handed inserters reach over the A belt)
  A belt    (or infinity chests for "S" slots, e.g. science packs for labs)
  top inserter row:    slots per machine column
  machine (size x size)
  bottom inserter row: slots per machine column
  output belt
  [C belt]  only if some slot uses C (long-handed inserters reach over the output belt)
Slots: A/B/C = insert from that belt, S = insert from the chest above, O = take out to the output
belt, anything else = empty (fluid ports go there, infinity pipes are placed on them).
]]
local function line_block(x0, y0, spec)
  local size = spec.size or 3
  local pitch = spec.pitch or size
  local per_segment = spec.per_segment or 5
  local top, bottom = spec.top, spec.bottom or {}
  local uses = {}
  for _, slot in pairs(top) do uses[slot] = true end
  for _, slot in pairs(bottom) do uses[slot] = true end

  local rows = {}
  local h = 0
  if uses.B then rows.B = h; h = h + 1 end
  rows.A = h; h = h + 1
  rows.top = h; h = h + 1
  rows.machine = h; h = h + size
  rows.bottom = h; h = h + 1
  rows.O = h; h = h + 1
  if uses.C then rows.C = h; h = h + 1 end

  local segment_width = per_segment * pitch
  local segments = math.floor((CELL - 3) / (segment_width + 3))
  local row_count = math.floor(CELL / h)
  local belt = spec.belt or "express-transport-belt"
  local inserters = {
    A = spec.inserter or "bulk-inserter",
    S = spec.inserter or "bulk-inserter",
    O = spec.output_inserter or spec.inserter or "bulk-inserter",
    B = "long-handed-inserter",
    C = "long-handed-inserter",
  }
  for r = 0, row_count - 1 do
    local ry = y0 + r * h
    for g = 0, segments do
      local gx = x0 + g * (segment_width + 3)
      substation(gx + 1, ry + rows.machine + 1)
      if g == segments then break end
      local sx = gx + 3
      for _, key in pairs({ "A", "B", "C" }) do
        if uses[key] and not spec.missing[key] then
          feed_belt(sx, ry + rows[key], segment_width, belt, spec.items[key], spec.starved[key])
        end
      end
      if uses.O then output_belt(sx, ry + rows.O, segment_width, belt, spec.output_blocked) end
      for m = 0, per_segment - 1 do
        local mx = sx + m * pitch
        local machine = create(spec.machine, mx + size / 2, ry + rows.machine + size / 2, N)
        if spec.recipe and not spec.no_recipe then machine.set_recipe(spec.recipe) end
        for c = 1, size do
          local x = mx + c - 0.5
          local slot = top[c]
          if slot == "S" then
            source(x, ry + rows.A + 0.5, spec.items.S)
            create(inserters.S, x, ry + rows.top + 0.5, N)
          elseif inserters[slot] and not spec.missing[slot] then
            create(inserters[slot], x, ry + rows.top + 0.5, N)
          end
          slot = bottom[c]
          if slot == "O" then
            create(inserters.O, x, ry + rows.bottom + 0.5, N)
          elseif slot == "C" and not spec.missing.C then
            create(inserters.C, x, ry + rows.bottom + 0.5, S)
          end
        end
        if spec.recipe and not spec.no_recipe then connect_fluids(machine, spec) end
      end
    end
  end
end

--- Mining field: an ore patch over the whole block, pairs of drill rows facing a shared belt.
local function mining_block(x0, y0, spec)
  if spec.ore then
    for x = x0, x0 + CELL - 1 do
      for y = y0, y0 + CELL - 1 do
        surface.create_entity({ name = spec.ore, position = { x + 0.5, y + 0.5 }, amount = spec.amount or 500000 })
      end
    end
  end
  local per_segment = 5
  local segment_width = per_segment * 3
  local segments = math.floor((CELL - 3) / (segment_width + 3))
  local length = segments * (segment_width + 3)
  for ry = y0, y0 + CELL - 7, 7 do
    -- drills (rows ry..ry+2) | belt (ry+3) | drills (ry+4..ry+6)
    for g = 0, segments do
      local gx = x0 + g * (segment_width + 3)
      substation(gx + 1, ry + 2)
      if g == segments then break end
      for m = 0, per_segment - 1 do
        local mx = gx + 3 + m * 3 + 1.5
        create("electric-mining-drill", mx, ry + 1.5, S)
        create("electric-mining-drill", mx, ry + 5.5, N)
      end
    end
    output_belt(x0, ry + 3, length, "express-transport-belt")
  end
end

--- Oil field: pumpjacks on a 5 tile grid, each voiding into an infinity pipe.
local function oil_block(x0, y0, spec)
  for gx = 0, CELL - 5, 5 do
    for gy = 1, CELL - 5, 5 do
      local x, y = x0 + gx + 1.5, y0 + gy + 1.5
      surface.create_entity({ name = "crude-oil", position = { x, y }, amount = 3000000 })
      local pumpjack = create("pumpjack", x, y, N)
      connect_fluids(pumpjack, spec)
      if gx % 15 == 0 and gy % 15 == 1 then substation(x0 + gx + 4, y0 + gy + 4) end
    end
  end
end

--- Oil refineries on a 6x9 grid, substations in the free rows between them.
local function refinery_block(x0, y0, spec)
  substation(x0 + 1, y0 + 1) -- links the grid to the power source above the block
  for gy = 3, CELL - 6, 9 do
    for gx = 0, CELL - 6, 6 do
      local refinery = create("oil-refinery", x0 + gx + 2.5, y0 + gy + 2.5, N)
      refinery.set_recipe(spec.recipe)
      connect_fluids(refinery, spec)
    end
    for gx = 0, CELL - 2, 16 do substation(x0 + gx + 1, y0 + gy + 7) end
  end
end

-- ---- The factory ----

local function line(name, machine, recipe, top, bottom, items, extra)
  local spec = { kind = "line", name = name, machine = machine, recipe = recipe, top = top, bottom = bottom, items = items or {} }
  for k, v in pairs(extra or {}) do spec[k] = v end
  spec.missing = spec.missing or {}
  spec.starved = spec.starved or {}
  return spec
end

local AM2, AM3 = "assembling-machine-2", "assembling-machine-3"
local SMELT = { "A", "-", "-" }
local OUT1 = { "O", "-", "-" }
local THREE = { "A", "B", "-" }
local THREE_BOTTOM = { "O", "C", "-" }
local PACKS = {
  "automation-science-pack", "logistic-science-pack", "military-science-pack", "chemical-science-pack",
  "production-science-pack", "utility-science-pack", "space-science-pack",
}
local PACKS_NO_UTILITY = {}
for _, p in pairs(PACKS) do if p ~= "utility-science-pack" then PACKS_NO_UTILITY[#PACKS_NO_UTILITY + 1] = p end end

local function furnace(name, ore, product)
  return line(name, "electric-furnace", nil, SMELT, OUT1, { A = ore },
    { inserter = "fast-inserter", belt = "fast-transport-belt", product = product, expect = "working" })
end

local function chem(name, recipe, top, bottom, items, extra)
  extra = extra or {}
  extra.pitch, extra.per_segment = 4, 3
  return line(name, "chemical-plant", recipe, top, bottom, items, extra)
end

-- Blocks by grid cell, row by row. `expect` is the dominant state tests should find.
local BLOCKS = {
  -- Row 0: raw resources
  { 0, 0, { kind = "mining", name = "Iron mine 1", ore = "iron-ore", expect = "working" } },
  { 1, 0, { kind = "mining", name = "Iron mine 2", ore = "iron-ore", expect = "working" } },
  { 2, 0, { kind = "mining", name = "Copper mine", ore = "copper-ore", expect = "working" } },
  { 3, 0, { kind = "mining", name = "Coal mine", ore = "coal", expect = "working" } },
  { 4, 0, { kind = "mining", name = "Stone mine (depleted)", ore = nil, expect = "no_minable_resources: the ore patch is gone" } },
  { 5, 0, { kind = "oil", name = "Oil field", product = "crude-oil", expect = "working" } },
  { 6, 0, { kind = "refinery", name = "Oil refinery", recipe = "advanced-oil-processing", expect = "working" } },
  { 7, 0, { kind = "refinery", name = "Oil refinery 2 (heavy oil backed up)", recipe = "advanced-oil-processing",
    fluid_blocked = "heavy-oil", expect = "full_output: the heavy oil outputs are not connected to anything" } },
  -- Row 1: smelting and chemistry
  { 0, 1, furnace("Iron smelting 1", "iron-ore", "iron-plate") },
  { 1, 1, furnace("Iron smelting 2", "iron-ore", "iron-plate") },
  { 2, 1, furnace("Copper smelting 1", "copper-ore", "copper-plate") },
  { 3, 1, furnace("Copper smelting 2", "copper-ore", "copper-plate") },
  { 4, 1, furnace("Steel smelting", "iron-plate", "steel-plate") },
  { 5, 1, furnace("Stone bricks", "stone", "stone-brick") },
  { 6, 1, chem("Plastic", "plastic-bar", { "-", "A", "-" }, { "-", "O", "-" }, { A = "coal" }, { expect = "working" }) },
  { 7, 1, chem("Sulfur", "sulfur", { "-", "-", "-" }, { "-", "O", "-" }, {}, { expect = "working" }) },
  -- Row 2: intermediates
  { 0, 2, line("Gears", AM3, "iron-gear-wheel", { "A", "-", "A" }, OUT1, { A = "iron-plate" }, { expect = "working" }) },
  { 1, 2, line("Gears 2 (output blocked)", AM3, "iron-gear-wheel", { "A", "-", "A" }, OUT1, { A = "iron-plate" },
    { output_blocked = true, expect = "full_output: the output belts end in nothing and are backed up" }) },
  { 2, 2, line("Pipes", AM3, "pipe", { "A", "-", "-" }, OUT1, { A = "iron-plate" }, { expect = "working" }) },
  -- Assembling machine 2s: inserters fill only the far belt lane, which 5 AM3s would overflow.
  { 3, 2, line("Copper cable", AM2, "copper-cable", { "A", "-", "-" }, { "O", "-", "O" }, { A = "copper-plate" }, { expect = "working" }) },
  { 4, 2, line("Copper cable 2 (low power)", AM2, "copper-cable", { "A", "-", "-" }, { "O", "-", "O" }, { A = "copper-plate" },
    { power = 40e6, expect = "low_power: its own grid with a 40 MW source for ~90 MW of machines" }) },
  { 5, 2, chem("Sulfuric acid", "sulfuric-acid", { "-", "A", "-" }, { "-", "C", "-" }, { A = "sulfur", C = "iron-plate" }, { expect = "working" }) },
  { 6, 2, chem("Lubricant", "lubricant", { "-", "-", "-" }, { "-", "-", "-" }, {}, { expect = "working" }) },
  { 7, 2, line("Spare assemblers (no recipe)", AM3, nil, { "A", "-", "-" }, OUT1, { A = "iron-plate" },
    { no_recipe = true, expect = "no_recipe: machines were never given a recipe" }) },
  -- Row 3: circuits (a rail line with named stations runs in the street above)
  { 0, 3, line("Green circuits 1", AM3, "electronic-circuit", { "A", "B", "A" }, OUT1, { A = "copper-cable", B = "iron-plate" }, { expect = "working" }) },
  { 1, 3, line("Green circuits 2", AM3, "electronic-circuit", { "A", "B", "A" }, OUT1, { A = "copper-cable", B = "iron-plate" }, { expect = "working" }) },
  { 2, 3, line("Green circuits 3 (unpowered)", AM3, "electronic-circuit", { "A", "B", "A" }, OUT1, { A = "copper-cable", B = "iron-plate" },
    { power = "none", expect = "no_power: its substations are not connected to any power source" }) },
  { 3, 3, line("Red circuits 1", AM3, "advanced-circuit", THREE, THREE_BOTTOM,
    { A = "copper-cable", B = "electronic-circuit", C = "plastic-bar" }, { expect = "working" }) },
  { 4, 3, line("Red circuits 2 (no plastic)", AM3, "advanced-circuit", THREE, THREE_BOTTOM,
    { A = "copper-cable", B = "electronic-circuit", C = "plastic-bar" },
    { starved = { C = true }, expect = "item_ingredient_shortage: the plastic supply chests (C belts) are empty" }) },
  { 5, 3, line("Blue circuits 1", AM3, "processing-unit", { "A", "-", "B" }, OUT1, { A = "electronic-circuit", B = "advanced-circuit" }, { expect = "working" }) },
  { 6, 3, line("Blue circuits 2 (no acid)", AM3, "processing-unit", { "A", "-", "B" }, OUT1, { A = "electronic-circuit", B = "advanced-circuit" },
    { fluid_starved = "sulfuric-acid", expect = "fluid_ingredient_shortage: the sulfuric acid pipes are empty" }) },
  { 7, 3, line("Low density structures", AM3, "low-density-structure", THREE, THREE_BOTTOM,
    { A = "copper-plate", B = "steel-plate", C = "plastic-bar" }, { expect = "working" }) },
  -- Row 4: engines and science
  { 0, 4, line("Engines 1", AM3, "engine-unit", THREE, THREE_BOTTOM, { A = "pipe", B = "steel-plate", C = "iron-gear-wheel" }, { expect = "working" }) },
  { 1, 4, line("Engines 2 (no gear supply)", AM3, "engine-unit", THREE, THREE_BOTTOM, { A = "pipe", B = "steel-plate", C = "iron-gear-wheel" },
    { missing = { C = true }, expect = "item_ingredient_shortage: no gear belt or gear inserters were ever built" }) },
  { 2, 4, line("Electric engines", AM3, "electric-engine-unit", { "A", "-", "-" }, THREE_BOTTOM, { A = "electronic-circuit", C = "engine-unit" }, { expect = "working" }) },
  { 3, 4, line("Red science", AM3, "automation-science-pack", THREE, OUT1, { A = "copper-plate", B = "iron-gear-wheel" }, { expect = "working" }) },
  { 4, 4, line("Green science", AM3, "logistic-science-pack", THREE, OUT1, { A = "inserter", B = "transport-belt" }, { expect = "working" }) },
  { 5, 4, line("Blue science", AM3, "chemical-science-pack", THREE, THREE_BOTTOM,
    { A = "advanced-circuit", B = "engine-unit", C = "sulfur" }, { expect = "working" }) },
  { 6, 4, line("Military science", AM3, "military-science-pack", THREE, THREE_BOTTOM,
    { A = "piercing-rounds-magazine", B = "grenade", C = "stone-wall" }, { expect = "working" }) },
  { 7, 4, line("Purple science", AM3, "production-science-pack", THREE, THREE_BOTTOM,
    { A = "rail", B = "electric-furnace", C = "productivity-module" }, { expect = "working" }) },
  -- Row 5: more science and research
  { 0, 5, line("Yellow science", AM3, "utility-science-pack", THREE, THREE_BOTTOM,
    { A = "low-density-structure", B = "processing-unit", C = "flying-robot-frame" }, { expect = "working" }) },
  { 1, 5, line("Labs 1", "lab", nil, { "-", "S", "-" }, {}, { S = PACKS }, { inserter = "fast-inserter", expect = "working (researching)" }) },
  { 2, 5, line("Labs 2", "lab", nil, { "-", "S", "-" }, {}, { S = PACKS }, { inserter = "fast-inserter", expect = "working (researching)" }) },
  { 3, 5, line("Labs 3 (no utility science)", "lab", nil, { "-", "S", "-" }, {}, { S = PACKS_NO_UTILITY },
    { inserter = "fast-inserter", expect = "missing_science_packs: the supply chests have no utility science packs" }) },
  { 4, 5, line("Green circuits 4", AM3, "electronic-circuit", { "A", "B", "A" }, OUT1, { A = "copper-cable", B = "iron-plate" }, { expect = "working" }) },
  { 5, 5, furnace("Iron smelting 3", "iron-ore", "iron-plate") },
  { 6, 5, line("Gears 3", AM3, "iron-gear-wheel", { "A", "-", "A" }, OUT1, { A = "iron-plate" }, { expect = "working" }) },
  { 7, 5, furnace("Copper smelting 3", "copper-ore", "copper-plate") },
}

local COLUMNS, ROWS = 8, 6
local function cell_origin(col, row)
  return ORIGIN.x + col * PITCH, ORIGIN.y + row * PITCH
end

local STREET_RAIL_Y = ORIGIN.y + 3 * PITCH - 16 -- middle of the street above row 3
local STREET_ROBOTS_Y = ORIGIN.y + PITCH - 16 -- middle of the street above row 1
local STATIONS = {
  { x = 230, name = "Iron Ore Drop" },
  { x = 390, name = "Copper Ore Drop" },
  { x = 550, name = "Coal Pickup" },
  { x = 710, name = "Plastic Pickup" },
  { x = 870, name = "Circuit Pickup" },
  { x = 1030, name = "Science Drop" },
  { x = 1190, name = "Depot" },
}
local BUILDING_STOCK = {
  ["assembling-machine-3"] = 200, ["electric-furnace"] = 100, ["bulk-inserter"] = 400, ["fast-inserter"] = 400,
  ["long-handed-inserter"] = 200, ["express-transport-belt"] = 2000, ["fast-transport-belt"] = 1000,
  ["express-underground-belt"] = 100, ["express-splitter"] = 50, ["substation"] = 100, ["medium-electric-pole"] = 200,
  ["steel-chest"] = 100, ["pipe"] = 400, ["pipe-to-ground"] = 100, ["chemical-plant"] = 50, ["electric-mining-drill"] = 100,
}

local function prepare(x0, y0, width, height, tile)
  local area = { { x0, y0 }, { x0 + width, y0 + height } }
  surface.request_to_generate_chunks({ x0 + width / 2, y0 + height / 2 }, math.ceil(math.max(width, height) / 64) + 1)
  surface.force_generate_chunk_requests()
  for _, e in pairs(surface.find_entities_filtered({ area = area })) do
    if e.valid and e.type ~= "character" then e.destroy() end
  end
  surface.destroy_decoratives({ area = area })
  local tiles = {}
  for x = x0, x0 + width - 1 do
    for y = y0, y0 + height - 1 do tiles[#tiles + 1] = { name = tile, position = { x, y } } end
  end
  surface.set_tiles(tiles)
end

local function build_block(index)
  local col, row, spec = BLOCKS[index][1], BLOCKS[index][2], BLOCKS[index][3]
  local x0, y0 = cell_origin(col, row)
  local pave = (spec.kind == "mining" or spec.kind == "oil") and "landfill" or "refined-concrete"
  prepare(x0 - 16, y0 - 16, PITCH, PITCH, "concrete")
  prepare(x0, y0, CELL, CELL, pave)
  label(x0 + 2, y0 - 12, spec.name)
  if spec.kind == "line" then line_block(x0, y0, spec)
  elseif spec.kind == "mining" then mining_block(x0, y0, spec)
  elseif spec.kind == "oil" then oil_block(x0, y0, spec)
  elseif spec.kind == "refinery" then refinery_block(x0, y0, spec)
  end
  -- Each block is its own electric grid, fed just above its top-left substation.
  if spec.power ~= "none" then power(x0 + 1, y0 - 2, type(spec.power) == "number" and spec.power or POWER) end
end

local function build_rails()
  local x0, x1 = ORIGIN.x - 16, ORIGIN.x + COLUMNS * PITCH - 16
  local y = STREET_RAIL_Y + 1
  for x = x0 + 1, x1 - 1, 2 do create("straight-rail", x, y, E) end
  for i, station in pairs(STATIONS) do
    local stop = create("train-stop", station.x + 1, y + 2, E)
    stop.backer_name = station.name
    if i % 3 == 1 then
      -- A parked train: locomotive at the stop, two cargo wagons behind it.
      local locomotive = create("locomotive", station.x - 2, y, E)
      locomotive.get_fuel_inventory().insert({ name = "solid-fuel", count = 50 })
      create("cargo-wagon", station.x - 9, y, E)
      create("cargo-wagon", station.x - 16, y, E)
    end
  end
end

local function build_robots()
  local x0, x1 = ORIGIN.x - 16, ORIGIN.x + COLUMNS * PITCH - 16
  local y = STREET_ROBOTS_Y
  for x = x0 + 2, x1 - 2, 18 do substation(x, y - 6) end
  power(x0 + 2, y - 9, POWER)
  for x = x0 + 24, x1 - 24, 48 do
    local roboport = create("roboport", x, y)
    roboport.insert({ name = "construction-robot", count = 25 })
    roboport.insert({ name = "logistic-robot", count = 25 })
  end
  for i = 0, 3 do
    local chest = create("storage-chest", x0 + 30.5 + i, y + 4.5)
    if i == 0 then for name, count in pairs(BUILDING_STOCK) do chest.insert({ name = name, count = count }) end end
  end
end

local function finish()
  -- Nothing should attack the fixture: no enemies anywhere, none coming back.
  for _, e in pairs(surface.find_entities_filtered({ force = "enemy" })) do e.destroy() end
  game.forces[FORCE].add_research(RESEARCH)
end

--- The labs research an infinite technology; queue its next level whenever one finishes.
local function on_research_finished(event)
  local tech = event.research
  if tech.name == RESEARCH and tech.force.name == FORCE then tech.force.add_research(RESEARCH) end
end

-- ---- Jobs, one per tick ----

local JOBS = {}
for i = 1, #BLOCKS do JOBS[#JOBS + 1] = { name = BLOCKS[i][3].name, run = function() build_block(i) end } end
JOBS[#JOBS + 1] = { name = "rails", run = build_rails }
JOBS[#JOBS + 1] = { name = "robots", run = build_robots }
JOBS[#JOBS + 1] = { name = "finish", run = finish }

local function count_chunks()
  local chunks, used = 0, 0
  for chunk in surface.get_chunks() do
    chunks = chunks + 1
    if surface.count_entities_filtered({ area = chunk.area, force = FORCE, limit = 1 }) > 0 then used = used + 1 end
  end
  return chunks, used
end

-- Script time spent generating (not saved: generation finishes long before anyone saves).
local profiler

local function on_tick()
  local state = storage.megabase
  if not state or state.done then return end
  surface = game.surfaces.nauvis
  if not profiler then profiler = helpers.create_profiler(true) end
  local job = JOBS[state.next]
  profiler.restart()
  job.run()
  profiler.stop()
  log({ "", "flh-megabase: ", state.next, "/", #JOBS, " ", job.name })
  state.next = state.next + 1
  if state.next > #JOBS then
    state.done = true
    state.entities = surface.count_entities_filtered({ force = FORCE })
    state.chunks, state.used_chunks = count_chunks()
    state.done_tick = game.tick
    log({ "", "flh-megabase: done, ", state.entities, " entities of ", FORCE, " in ", state.used_chunks,
      " chunks (", state.chunks, " generated), generation script time ", profiler })
  end
end

local function status()
  local state = storage.megabase
  return {
    done = state.done or false,
    progress = (state.next - 1) .. "/" .. #JOBS,
    entities = state.entities,
    chunks = state.chunks,
    used_chunks = state.used_chunks,
    done_tick = state.done_tick,
  }
end

local function block_list()
  local list = {}
  for _, block in pairs(BLOCKS) do
    local x0, y0 = cell_origin(block[1], block[2])
    local spec = block[3]
    list[#list + 1] = {
      name = spec.name,
      cell = { block[1], block[2] },
      area = { left_top = { x = x0, y = y0 }, right_bottom = { x = x0 + CELL, y = y0 + CELL } },
      recipe = spec.recipe or spec.product or spec.ore, -- furnaces: what they make, mines: the ore
      expect = spec.expect,
    }
  end
  return list
end

remote.add_interface("flh-megabase", { status = status, blocks = block_list })

return {
  on_init = function()
    remote.call("freeplay", "set_skip_intro", true)
    remote.call("freeplay", "set_disable_crashsite", true)
    local force = game.forces[FORCE]
    research_nauvis(force)
    local nauvis = game.surfaces.nauvis
    nauvis.peaceful_mode = true
    game.map_settings.enemy_expansion.enabled = false
    storage.megabase = { next = 1 }
  end,
  events = {
    [defines.events.on_tick] = on_tick,
    [defines.events.on_research_finished] = on_research_finished,
  },
}
