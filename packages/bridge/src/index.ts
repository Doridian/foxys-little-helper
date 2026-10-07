import { Agent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { DesignStore } from "./designs.ts";
import { factoryIndex } from "./factory/service.ts";
import { GameClient } from "./game.ts";
import { PlannerService } from "./planner/service.ts";
import { Rcon } from "./rcon.ts";
import { Transcript } from "./transcript.ts";

const config = loadConfig();
const rcon = new Rcon(config.rconHost, config.rconPort, config.rconPassword);
const game = new GameClient(rcon);
const planner = new PlannerService(game);
const designs = new DesignStore(game, config.blueprintDir);
const agent = new Agent(game, config, planner, designs, new Transcript(config.transcriptDir));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureConnected(): Promise<void> {
  while (!rcon.connected) {
    try {
      await rcon.connect();
      planner.invalidate();
      factoryIndex(game, planner).invalidate();
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
        switch (event.type) {
          case "player_message":
            agent.handleMessage(event.player_index, event.player_name, event.message);
            break;
          case "player_cancel":
            agent.cancel(event.player_index, event.player_name);
            break;
          case "area_selected": {
            const { left_top: lt, right_bottom: rb } = event.area;
            const contents = Object.entries(event.entities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([name, n]) => `${n} ${name}`)
              .join(", ");
            agent.note(
              event.player_index,
              event.player_name,
              `${event.player_name} marked an area on ${event.surface} from (${lt.x},${lt.y}) to (${rb.x},${rb.y}), ${rb.x - lt.x}x${rb.y - lt.y} tiles, containing ${contents || "nothing"}`,
            );
            break;
          }
          case "proposal_resolved":
            agent.note(
              event.player_index,
              event.player_name,
              `proposal #${event.id} was ${event.outcome === "blueprint" ? "taken as a blueprint into the cursor" : event.outcome}${event.outcome === "approved" ? ` (${event.built} ghosts placed)` : ""} by ${event.player_name} via the panel`,
            );
            break;
        }
      }
    } catch (err) {
      console.error("[bridge] poll failed:", (err as Error).message);
    }
    await sleep(config.pollIntervalMs);
  }
}

void main();
