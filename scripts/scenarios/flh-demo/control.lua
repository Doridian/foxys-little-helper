-- Dev scenario: normal freeplay plus a small pre-built test factory (see demo-factory.lua).
local handler = require("event_handler")
handler.add_lib(require("__base__/script/freeplay/freeplay"))
handler.add_lib(require("demo-factory"))
