import { Agent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { GameClient } from "./game.ts";
import { PlannerService } from "./planner/service.ts";
import { Rcon } from "./rcon.ts";

const config = loadConfig();
const rcon = new Rcon(config.rconHost, config.rconPort, config.rconPassword);
const game = new GameClient(rcon);
const planner = new PlannerService(game);
const agent = new Agent(game, config, planner);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureConnected(): Promise<void> {
  while (!rcon.connected) {
    try {
      await rcon.connect();
      planner.invalidate();
      console.log(`[bridge] connected to ${config.rconHost}:${config.rconPort}`);
    } catch (err) {
      console.error(`[bridge] RCON connect failed (${(err as Error).message}), retrying in 5s`);
      await sleep(5000);
    }
  }
}

async function main(): Promise<void> {
  for (;;) {
    await ensureConnected();
    try {
      for (const event of await game.call("poll_events", {})) {
        console.log(`[bridge] event`, event);
        if (event.type === "player_message") agent.handleMessage(event.player_index, event.player_name, event.message);
        else if (event.type === "player_cancel") agent.cancel(event.player_index, event.player_name);
      }
    } catch (err) {
      console.error("[bridge] poll failed:", (err as Error).message);
    }
    await sleep(config.pollIntervalMs);
  }
}

void main();
