// Headless test harness: sends one request through the real agent (Claude + tools + mod) as if a
// player had asked, and prints the resulting transcript. Costs API tokens.
//   npm run ask -w @flh/bridge -- "why aren't we making red circuits?"
//   FLH_ASK_PLAYER=1 FLH_ASK_NAME=Tester ...   (player index/name to act as; default 1 / Tester)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { DesignStore } from "./designs.ts";
import { GameClient } from "./game.ts";
import { PlannerService } from "./planner/service.ts";
import { Rcon } from "./rcon.ts";
import { Transcript } from "./transcript.ts";
import { formatTranscript } from "./transcript-format.ts";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('usage: npm run ask -w @flh/bridge -- "<question>"');
  process.exit(1);
}
process.env.FLH_RCON_PASSWORD ??= "flh-dev";
const config = loadConfig();
const rcon = new Rcon(config.rconHost, config.rconPort, config.rconPassword);
await rcon.connect();
const game = new GameClient(rcon);
const agent = new Agent(game, config, new PlannerService(game), new DesignStore(game, config.blueprintDir), new Transcript(config.transcriptDir));

await agent.handleMessage(Number(process.env.FLH_ASK_PLAYER ?? 1), process.env.FLH_ASK_NAME ?? "Tester", question);
rcon.close();

const file = join(config.transcriptDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log(formatTranscript(lines, 1, process.env.FLH_ASK_FULL === "1"));
