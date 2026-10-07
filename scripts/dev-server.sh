#!/usr/bin/env bash
# Runs a throwaway headless Factorio server for development, isolated in ./dev
# (its own write-data dir, so your normal ~/.factorio is untouched).
#
#   FACTORIO_BIN       path to the factorio binary (default: Steam install)
#   FLH_DEV_DIR        dev data directory (default ./dev); give parallel worktrees their own
#   FLH_GAME_PORT      UDP game port (default 34197)
#   FLH_RCON_PORT      default 27015
#   FLH_RCON_PASSWORD  default flh-dev
#   FLH_SCENARIO       scenario from scripts/scenarios to start fresh each run (default flh-demo);
#                      set it empty to keep playing a persistent save instead
#   FLH_SAVE           save to load when FLH_SCENARIO is empty (default dev/saves/dev.zip; created if missing)
#   FLH_DEV_FOG_OFF=1  TEST ONLY: also load the flh-dev mod, which lifts fog of war (servers only
#                      chart while players are connected, so automated tests need it). Clients
#                      without that mod can't join such a server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${FLH_DEV_DIR:-$ROOT/dev}"
GAME_PORT="${FLH_GAME_PORT:-34197}"
FACTORIO_BIN="${FACTORIO_BIN:-$HOME/.local/share/Steam/steamapps/common/Factorio/bin/x64/factorio}"
RCON_PORT="${FLH_RCON_PORT:-27015}"
RCON_PASSWORD="${FLH_RCON_PASSWORD:-flh-dev}"
SAVE="${FLH_SAVE:-$DEV/saves/dev.zip}"
SCENARIO="${FLH_SCENARIO-flh-demo}"

mkdir -p "$DEV/data/mods" "$DEV/data/scenarios" "$DEV/saves"
cat > "$DEV/config.ini" <<INI
[path]
read-data=__PATH__executable__/../../data
write-data=$DEV/data
INI

(cd "$ROOT" && npm run build:mod)
ln -sfn "$ROOT/packages/mod/build/foxys-little-helper" "$DEV/data/mods/foxys-little-helper"
if [[ "${FLH_DEV_FOG_OFF:-}" == "1" ]]; then
  ln -sfn "$ROOT/scripts/dev-mods/flh-dev" "$DEV/data/mods/flh-dev"
  echo "WARNING: flh-dev loaded, fog of war is OFF for the helper (test only)" >&2
else
  rm -f "$DEV/data/mods/flh-dev"
fi
# Enable exactly what is linked (Factorio keeps disabled mods in mod-list.json otherwise).
node -e '
  const fs = require("fs"); const file = process.argv[1] + "/mod-list.json";
  let list = { mods: [] }; try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const want = new Set(["foxys-little-helper", ...(process.argv[2] === "1" ? ["flh-dev"] : [])]);
  list.mods = list.mods.filter((m) => m.name !== "flh-dev" && m.name !== "foxys-little-helper");
  for (const name of want) list.mods.push({ name, enabled: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
' "$DEV/data/mods" "${FLH_DEV_FOG_OFF:-}"

# Keep ticking with nobody connected, otherwise radars never chart and the helper is blind.
FACTORIO_DATA="$(dirname "$FACTORIO_BIN")/../../data"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  Object.assign(s, { name: "FLH dev", visibility: { public: false, lan: false }, require_user_verification: false, auto_pause: false });
  require("fs").writeFileSync(process.argv[2], JSON.stringify(s, null, 2));
' "$FACTORIO_DATA/server-settings.example.json" "$DEV/server-settings.json"

if [[ -n "$SCENARIO" ]]; then
  ln -sfn "$ROOT/scripts/scenarios/$SCENARIO" "$DEV/data/scenarios/$SCENARIO"
  START=(--start-server-load-scenario "$SCENARIO")
else
  if [[ ! -f "$SAVE" ]]; then
    "$FACTORIO_BIN" --config "$DEV/config.ini" --create "$SAVE"
  fi
  START=(--start-server "$SAVE")
fi

exec "$FACTORIO_BIN" --config "$DEV/config.ini" "${START[@]}" \
  --server-settings "$DEV/server-settings.json" --port "$GAME_PORT" \
  --rcon-port "$RCON_PORT" --rcon-password "$RCON_PASSWORD"
