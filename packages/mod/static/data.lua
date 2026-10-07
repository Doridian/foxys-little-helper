-- Selection tool for marking an area for the helper ("build here", "look at this"), plus a
-- shortcut-bar button that puts it in the cursor.
local icon = "__base__/graphics/icons/blueprint.png"

data:extend({
  {
    type = "selection-tool",
    name = "flh-area-tool",
    icon = icon,
    icon_size = 64,
    flags = { "only-in-cursor", "not-stackable", "spawnable" },
    hidden = true,
    subgroup = "tool",
    order = "z[flh-area-tool]",
    stack_size = 1,
    select = {
      border_color = { 1, 0.65, 0 },
      cursor_box_type = "copy",
      mode = { "any-entity", "any-tile" },
    },
    alt_select = {
      border_color = { 0.6, 0.6, 0.6 },
      cursor_box_type = "not-allowed",
      mode = { "nothing" },
    },
  },
  {
    type = "shortcut",
    name = "flh-area-tool",
    action = "spawn-item",
    item_to_spawn = "flh-area-tool",
    icon = icon,
    icon_size = 64,
    small_icon = icon,
    small_icon_size = 64,
    order = "z[flh-area-tool]",
  },
})

-- "Ask the helper" window: shortcut-bar button and hotkey.
local ask_icon = "__base__/graphics/icons/programmable-speaker.png"
data:extend({
  {
    type = "shortcut",
    name = "flh-ask",
    action = "lua",
    icon = ask_icon,
    icon_size = 64,
    small_icon = ask_icon,
    small_icon_size = 64,
    order = "z[flh-ask]",
  },
  {
    type = "custom-input",
    name = "flh-ask",
    key_sequence = "CONTROL + SHIFT + H",
    consuming = "none",
  },
})
