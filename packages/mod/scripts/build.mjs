// Compiles the mod with TypeScriptToLua and copies static files (info.json, locale, settings.lua)
// into build/foxies-little-helper, which can be symlinked into a Factorio mods directory.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "foxies-little-helper");

rmSync(out, { recursive: true, force: true });
execFileSync("npx", ["tstl", "-p", join(root, "tsconfig.json")], { cwd: root, stdio: "inherit" });
cpSync(join(root, "static"), out, { recursive: true });
console.log(`Built mod into ${out}`);
