// Player-facing interaction: /flh command, chat trigger prefix, and the event queue the
// bridge drains through the `poll_events` RPC.

import { GameEvent } from "@flh/protocol";
import { LuaPlayer, PlayerIndex } from "factorio:runtime";
import { appendHistory, openAsk, setRequestStatus } from "./ui";

const MAX_QUEUED_EVENTS = 100;
const PRINT_PREFIX = "[color=255,165,0][FLH][/color] ";

function queue(): GameEvent[] {
  storage.events ??= [];
  return storage.events;
}

export function pushEvent(event: GameEvent): void {
  const events = queue();
  events.push(event);
  while (events.length > MAX_QUEUED_EVENTS) events.shift();
}

export function drainEvents(): GameEvent[] {
  const events = queue();
  storage.events = [];
  return events;
}

/**
 * Prints a helper message in chat (to everyone, or only to `playerIndex` when private) and adds
 * it to that player's conversation history in the ask window.
 */
export function say(message: string, playerIndex?: number, isPrivate = false): void {
  // Unknown players (e.g. the headless test harness) just get a public message.
  const player = playerIndex === undefined ? undefined : game.get_player(playerIndex as PlayerIndex);
  if (player && isPrivate) player.print(PRINT_PREFIX + message);
  else game.print(PRINT_PREFIX + message);
  if (player) appendHistory(player.index, "flh", message);
}

export function cancel(player: LuaPlayer): void {
  const request = storage.requests?.[player.index];
  if (request) setRequestStatus(player.index, { ...request, state: "stopping" });
  pushEvent({ type: "player_cancel", tick: game.tick, player_index: player.index, player_name: player.name });
}

export function submit(player: LuaPlayer, message: string): void {
  const trimmed = message.trim();
  if (trimmed === "") {
    openAsk(player);
    return;
  }
  if (trimmed.toLowerCase() === "stop") {
    cancel(player);
    return;
  }
  appendHistory(player.index, "you", trimmed);
  const current = storage.requests?.[player.index];
  setRequestStatus(player.index, {
    text: current ? `${current.text} + ${trimmed}` : trimmed,
    state: current?.state ?? "queued",
    detail: current?.detail,
    since: current?.since ?? game.tick,
  });
  pushEvent({
    type: "player_message",
    tick: game.tick,
    player_index: player.index,
    player_name: player.name,
    message: trimmed,
  });
}

export function registerChat(): void {
  commands.add_command("flh", "Talk to Foxie's Little Helper. /flh <request>, /flh stop, or just /flh to open the ask window", (event) => {
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
