-- Scale test scenario: normal freeplay plus a large scripted factory (see megabase.lua).
local handler = require("event_handler")
handler.add_lib(require("__base__/script/freeplay/freeplay"))
handler.add_lib(require("megabase"))
