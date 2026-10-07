data:extend({
  {
    type = "string-setting",
    name = "flh-chat-prefix",
    setting_type = "runtime-global",
    default_value = "flh,",
    allow_blank = true,
    order = "a",
  },
  {
    type = "double-setting",
    name = "flh-index-chunks-per-tick",
    setting_type = "runtime-global",
    default_value = 3,
    minimum_value = 0,
    maximum_value = 100,
    order = "b",
  },
})
