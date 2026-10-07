// Dev helper: run one console command on the dev server and print the output.
//   npm run rcon -w @flh/bridge -- '/c rcon.print(game.tick)'
import { Rcon } from "./rcon.ts";

const rcon = new Rcon(
  process.env.FLH_RCON_HOST ?? "127.0.0.1",
  Number(process.env.FLH_RCON_PORT ?? 27015),
  process.env.FLH_RCON_PASSWORD ?? "flh-dev",
);
await rcon.connect();
console.log(await rcon.exec(process.argv.slice(2).join(" ")));
rcon.close();
