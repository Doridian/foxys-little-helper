// The FLH panel (top-left): the player's request in progress, and build proposals waiting for
// their approval.

import { RpcMethods } from "@flh/protocol";
import { LuaGuiElement, LuaPlayer, PlayerIndex, ScrollPaneGuiElement, TextBoxGuiElement } from "factorio:runtime";

const PANEL = "flh_panel";
const ASK = "flh_ask";
const MAX_HISTORY = 30;

function elapsed(since: number): string {
  const seconds = math.floor((game.tick - since) / 60);
  return seconds < 60 ? `${seconds}s` : `${math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STATE_TEXT = { queued: "Sent, waiting for the helper…", thinking: "Thinking…", stopping: "Stopping…" };

export function refreshPanel(player: LuaPlayer): void {
  player.gui.left[PANEL]?.destroy();
  const request = storage.requests?.[player.index];
  const proposals = Object.values(storage.proposals ?? {}).filter((p) => p.player_index === player.index);
  if (!request && proposals.length === 0) return;

  const frame = player.gui.left.add({ type: "frame", name: PANEL, caption: "Foxy's Little Helper", direction: "vertical" });
  frame.add({ type: "button", caption: "Ask…", tags: { flh_action: "open_ask" }, tooltip: "Open the ask window (Ctrl+Shift+H)" });
  if (request) {
    const text = request.text.length > 60 ? `${request.text.substring(0, 57)}…` : request.text;
    frame.add({ type: "label", caption: `“${text}”`, tooltip: request.text });
    const row = frame.add({ type: "flow", name: "status_row", direction: "horizontal" });
    row.add({ type: "label", name: "status", caption: `${request.detail ?? STATE_TEXT[request.state]} (${elapsed(request.since)})` });
    if (request.state !== "stopping") row.add({ type: "button", caption: "Stop", tags: { flh_action: "stop" } });
  }
  for (const proposal of proposals) {
    frame.add({ type: "line" });
    frame.add({
      type: "label",
      caption: `#${proposal.id} ${proposal.label}: ${proposal.entity_count} entities${proposal.conflict_count > 0 ? `, [color=red]${proposal.conflict_count} blocked[/color]` : ""}`,
    });
    const row = frame.add({ type: "flow", direction: "horizontal" });
    row.add({ type: "button", caption: "Build", tags: { flh_action: "approved", id: proposal.id }, tooltip: "Place the ghosts; robots build them" });
    row.add({ type: "button", caption: "Blueprint", tags: { flh_action: "blueprint", id: proposal.id }, tooltip: "Put it in your cursor to place yourself" });
    row.add({ type: "button", caption: "Reject", tags: { flh_action: "rejected", id: proposal.id } });
  }
}

export function setRequestStatus(playerIndex: number, status: FlhRequestStatus | undefined): void {
  storage.requests ??= {};
  if (status) storage.requests[playerIndex] = status;
  else delete storage.requests[playerIndex];
  const player = game.get_player(playerIndex as PlayerIndex);
  if (player) refreshPanel(player);
}

export function setStatusRpc(params: RpcMethods["set_status"]["params"]): true {
  const current = storage.requests?.[params.player_index];
  if (params.state === "done") setRequestStatus(params.player_index, undefined);
  else if (current?.state !== "stopping") {
    setRequestStatus(params.player_index, {
      text: current?.text ?? "",
      state: "thinking",
      detail: params.detail,
      since: current?.since ?? game.tick,
    });
  }
  return true;
}

/** Keeps the elapsed time ticking while requests are in flight. */
export function tickPanels(): void {
  for (const [index, request] of pairs(storage.requests ?? {})) {
    const player = game.get_player(index as unknown as PlayerIndex);
    const status = player?.gui.left[PANEL]?.["status_row"]?.["status"] as LuaGuiElement | undefined;
    if (status) status.caption = `${request.detail ?? STATE_TEXT[request.state]} (${elapsed(request.since)})`;
  }
}

// ---- Ask window: multi-line input plus the player's recent conversation ----

export function appendHistory(playerIndex: number, from: "you" | "flh", text: string): void {
  storage.history ??= {};
  const history = (storage.history[playerIndex] ??= []);
  history.push({ from, text });
  while (history.length > MAX_HISTORY) history.shift();
  const player = game.get_player(playerIndex as PlayerIndex);
  if (player?.gui.screen[ASK]) fillHistory(player);
}

function fillHistory(player: LuaPlayer): void {
  const pane = player.gui.screen[ASK]?.["history"] as ScrollPaneGuiElement | undefined;
  if (!pane) return;
  pane.clear();
  const history = storage.history?.[player.index] ?? [];
  if (history.length === 0) {
    pane.add({ type: "label", caption: "[color=gray]Ask about your factory, or what to build. Use the area tool to mark a spot first.[/color]" });
  }
  for (const entry of history) {
    const label = pane.add({
      type: "label",
      caption: entry.from === "you" ? `[font=default-bold]You:[/font] ${entry.text}` : `[color=255,165,0][font=default-bold]FLH:[/font][/color] ${entry.text}`,
    });
    label.style.single_line = false;
    label.style.maximal_width = 520;
  }
  pane.scroll_to_bottom();
}

export function openAsk(player: LuaPlayer): void {
  let frame = player.gui.screen[ASK];
  if (!frame) {
    frame = player.gui.screen.add({ type: "frame", name: ASK, caption: "Ask Foxy's Little Helper", direction: "vertical" });
    frame.auto_center = true;
    const pane = frame.add({ type: "scroll-pane", name: "history" });
    pane.style.maximal_height = 350;
    pane.style.minimal_width = 540;
    const input = frame.add({ type: "text-box", name: "input", tags: { flh_action: "send" } });
    input.word_wrap = true;
    input.style.width = 540;
    input.style.height = 100;
    const row = frame.add({ type: "flow", direction: "horizontal" });
    row.add({ type: "button", caption: "Send", style: "confirm_button", tags: { flh_action: "send" } });
    row.add({ type: "button", caption: "Close", tags: { flh_action: "close_ask" } });
    fillHistory(player);
  }
  frame.bring_to_front();
  (frame["input"] as LuaGuiElement).focus();
}

export function toggleAsk(player: LuaPlayer): void {
  if (player.gui.screen[ASK]) player.gui.screen[ASK]!.destroy();
  else openAsk(player);
}

/** Takes the text out of the ask window's input box. */
export function takeAskInput(player: LuaPlayer): string {
  const input = player.gui.screen[ASK]?.["input"] as TextBoxGuiElement | undefined;
  if (!input) return "";
  const text = input.text;
  input.text = "";
  return text;
}

export function closeAsk(player: LuaPlayer): void {
  player.gui.screen[ASK]?.destroy();
}
