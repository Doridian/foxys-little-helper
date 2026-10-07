// RPC entry point. The bridge sends `/flh-rpc <json>` over RCON; we answer with rcon.print.
// Commands run inside the game tick, so everything here is deterministic and multiplayer-safe.

import { RpcMethod, RpcMethods, RpcRequest, RpcResponse } from "@flh/protocol";
import {
  addLibraryChestRpc,
  deconstruct,
  findSpace,
  giveBlueprint,
  listBlueprints,
  listProposals,
  proposeBuild,
  resolveProposalRpc,
  setRecipe,
  undoAction,
} from "./actions";
import { drainEvents, say } from "./chat";
import { indexChanges, indexStatus } from "./factory-index";
import { setStatusRpc } from "./ui";
import { forceRecipes, prototypeData, surfaceInfo } from "./prototypes";
import { findEntities, gameInfo, inspectEntity, production, statusSummary } from "./queries";

type Handlers = { [M in RpcMethod]: (params: RpcMethods[M]["params"]) => RpcMethods[M]["result"] };

const handlers: Handlers = {
  poll_events: () => drainEvents(),
  say: (p) => {
    say(p.message, p.player_index, p.private);
    return true;
  },
  game_info: gameInfo,
  production,
  find_entities: findEntities,
  status_summary: statusSummary,
  inspect_entity: inspectEntity,
  prototypes: prototypeData,
  force_recipes: forceRecipes,
  surface_info: surfaceInfo,
  propose_build: proposeBuild,
  resolve_proposal: resolveProposalRpc,
  list_proposals: listProposals,
  give_blueprint: giveBlueprint,
  undo_action: undoAction,
  deconstruct,
  set_recipe: setRecipe,
  find_space: findSpace,
  add_library_chest: addLibraryChestRpc,
  list_blueprints: listBlueprints,
  set_status: setStatusRpc,
  index_status: indexStatus,
  index_changes: indexChanges,
};

function reply(response: RpcResponse): void {
  rcon.print(helpers.table_to_json(response));
}

function handle(raw: string): void {
  const request = helpers.json_to_table(raw) as RpcRequest | undefined;
  if (!request || typeof request !== "object" || request.id === undefined) {
    reply({ id: -1, ok: false, error: "Malformed request" });
    return;
  }
  const handler = handlers[request.method] as ((params: unknown) => unknown) | undefined;
  if (!handler) {
    reply({ id: request.id, ok: false, error: `Unknown method '${request.method}'` });
    return;
  }
  const [ok, result] = pcall(handler, request.params ?? {});
  if (ok) {
    reply({ id: request.id, ok: true, result });
  } else {
    reply({ id: request.id, ok: false, error: tostring(result) });
  }
}

export function registerRpc(): void {
  commands.add_command("flh-rpc", "Internal: used by the Foxie's Little Helper bridge over RCON.", (event) => {
    // Only the server console / RCON may call this, never a player.
    if (event.player_index !== undefined) {
      game.get_player(event.player_index)?.print("This command is reserved for the FLH bridge.");
      return;
    }
    handle(event.parameter ?? "");
  });
}
