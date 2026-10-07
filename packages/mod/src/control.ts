import { LuaPlayer } from "factorio:runtime";
import { ProposalOutcome, registerSelection, resolveProposal } from "./actions";
import { cancel, registerChat, submit } from "./chat";
import { registerIndex } from "./factory-index";
import { registerRpc } from "./rpc";
import { closeAsk, openAsk, takeAskInput, tickPanels, toggleAsk } from "./ui";

registerRpc();
registerChat();
registerSelection();
registerIndex();

function send(player: LuaPlayer): void {
  const text = takeAskInput(player);
  if (text.trim() === "") return;
  // The panel shows progress and replies arrive in chat; the window reopens with the history.
  closeAsk(player);
  submit(player, text);
}

script.on_event(defines.events.on_gui_click, (event) => {
  const action = event.element.tags["flh_action"] as string | undefined;
  if (!action) return;
  const player = game.get_player(event.player_index)!;
  switch (action) {
    case "stop":
      cancel(player);
      break;
    case "open_ask":
      openAsk(player);
      break;
    case "close_ask":
      closeAsk(player);
      break;
    case "send":
      if (event.element.type === "button") send(player);
      break;
    case "approved":
    case "rejected":
    case "blueprint": {
      const [ok, err] = pcall(resolveProposal, event.element.tags["id"] as number, action as ProposalOutcome, player);
      if (!ok) player.print(`[color=255,165,0][FLH][/color] ${tostring(err)}`);
      break;
    }
  }
});

script.on_event(defines.events.on_gui_confirmed, (event) => {
  if (event.element.tags["flh_action"] === "send") send(game.get_player(event.player_index)!);
});

script.on_event("flh-ask", (event) => toggleAsk(game.get_player(event.player_index)!));
script.on_event(defines.events.on_lua_shortcut, (event) => {
  if (event.prototype_name === "flh-ask") toggleAsk(game.get_player(event.player_index)!);
});

script.on_nth_tick(60, tickPanels);
