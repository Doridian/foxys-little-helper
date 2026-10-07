// Player-facing interaction: /flh command, chat trigger prefix, and the event queue the
// bridge drains through the `poll_events` RPC.

import { GameEvent } from "@flh/protocol";
import { LuaPlayer, PlayerIndex } from "factorio:runtime";

const MAX_QUEUED_EVENTS = 100;
const PRINT_PREFIX = "[color=255,165,0][FLH][/color] ";

function queue(): GameEvent[] {
  storage.events ??= [];
  return storage.events;
}

function pushEvent(event: GameEvent): void {
  const events = queue();
  events.push(event);
  while (events.length > MAX_QUEUED_EVENTS) events.shift();
}

export function drainEvents(): GameEvent[] {
  const events = queue();
  storage.events = [];
  return events;
}

export function say(message: string, playerIndex?: number): void {
  if (playerIndex !== undefined) {
    const player = game.get_player(playerIndex as PlayerIndex);
    if (!player) throw `Unknown player ${playerIndex}`;
    player.print(PRINT_PREFIX + message);
  } else {
    game.print(PRINT_PREFIX + message);
  }
}

function submit(player: LuaPlayer, message: string): void {
  const trimmed = message.trim();
  if (trimmed === "") {
    player.print(PRINT_PREFIX + "Usage: /flh <request>, or /flh stop");
    return;
  }
  if (trimmed.toLowerCase() === "stop") {
    pushEvent({ type: "player_cancel", tick: game.tick, player_index: player.index, player_name: player.name });
    return;
  }
  pushEvent({
    type: "player_message",
    tick: game.tick,
    player_index: player.index,
    player_name: player.name,
    message: trimmed,
  });
}

export function registerChat(): void {
  commands.add_command("flh", "Talk to Foxie's Little Helper. /flh <request>, or /flh stop", (event) => {
    if (event.player_index === undefined) return;
    const player = game.get_player(event.player_index);
    if (player) submit(player, event.parameter ?? "");
  });

  script.on_event(defines.events.on_console_chat, (event) => {
    if (event.player_index === undefined) return;
    const prefix = (settings.global["flh-chat-prefix"]?.value as string | undefined) ?? "";
    if (prefix === "") return;
    if (event.message.toLowerCase().startsWith(prefix.toLowerCase())) {
      const player = game.get_player(event.player_index);
      if (player) submit(player, event.message.substring(prefix.length));
    }
  });
}
