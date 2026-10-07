// All the places designs come from, behind one id scheme the LLM can use:
//   c0/3, p1/5/2   in-game library (chests registered with add_library_chest, player inventory)
//   repo:<file>#<path>   blueprint strings in the repo's blueprints/ folder
//   gen:<n>        layouts generated this session
//   fp:<key>#<path>  public blueprints fetched from factorioprints.com this session (fp:<key> = the whole string)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlueprintSource, LibraryBlueprint } from "@flh/protocol";
import { decodeBlueprintString, encodeBlueprintString, type BlueprintJson, type BookJson } from "./blueprint-string.ts";
import type { GameClient } from "./game.ts";
import type { GeneratedLayout } from "./layouts.ts";

export const DEFAULT_BLUEPRINT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../blueprints");

interface RepoBlueprint {
  meta: LibraryBlueprint;
  blueprint: BlueprintJson;
}

export function summarize(id: string, bp: BlueprintJson, book?: string): LibraryBlueprint {
  const entities: Record<string, number> = {};
  const recipes: Record<string, number> = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of bp.entities ?? []) {
    entities[e.name] = (entities[e.name] ?? 0) + 1;
    if (e.recipe) recipes[e.recipe] = (recipes[e.recipe] ?? 0) + 1;
    minX = Math.min(minX, e.position.x);
    minY = Math.min(minY, e.position.y);
    maxX = Math.max(maxX, e.position.x);
    maxY = Math.max(maxY, e.position.y);
  }
  const size = minX === Infinity ? { width: 0, height: 0 } : { width: Math.ceil(maxX - minX + 1), height: Math.ceil(maxY - minY + 1) };
  return { id, label: bp.label, description: bp.description, book, size, entities, recipes };
}

function flattenBook(book: BookJson, path: string, label: string | undefined, out: (path: string, bp: BlueprintJson, book?: string) => void) {
  const name = label ? `${label} / ${book.label ?? "book"}` : book.label ?? "book";
  for (const entry of book.blueprints ?? []) {
    if (entry.blueprint) out(`${path}/${entry.index}`, entry.blueprint, name);
    if (entry.blueprint_book) flattenBook(entry.blueprint_book, `${path}/${entry.index}`, name, out);
  }
}

/** "2.0.55" from a blueprint's packed version number (four 16-bit parts). */
export function gameVersion(version: unknown): string | undefined {
  if (typeof version !== "number" || version <= 0) return undefined;
  const part = (shift: number) => Math.floor(version / 2 ** shift) % 65536;
  return `${part(48)}.${part(32)}.${part(16)}`;
}

export class DesignStore {
  private repo = new Map<string, RepoBlueprint>();
  /** Fetched public blueprints: whole exchange strings, and each blueprint in them. */
  private external = new Map<string, string>();
  private externalBlueprints = new Map<string, RepoBlueprint>();
  private generated = new Map<string, GeneratedLayout>();
  private nextGenerated = 1;

  constructor(
    private readonly game: GameClient,
    private readonly dir: string,
  ) {
    this.loadRepo();
  }

  loadRepo(): void {
    this.repo.clear();
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".txt"));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const json = decodeBlueprintString(readFileSync(join(this.dir, file), "utf8"));
        const add = (path: string, bp: BlueprintJson, book?: string) => {
          const id = `repo:${file}${path}`;
          this.repo.set(id, { meta: summarize(id, bp, book), blueprint: bp });
        };
        if (json.blueprint) add("", json.blueprint);
        if (json.blueprint_book) flattenBook(json.blueprint_book, "#", undefined, add);
      } catch (err) {
        console.error(`[designs] skipping ${file}: ${(err as Error).message}`);
      }
    }
    console.log(`[designs] ${this.repo.size} blueprints from ${this.dir}`);
  }

  /**
   * Registers a fetched exchange string (blueprint or book) under `prefix`: `prefix` is the whole
   * string, `prefix#/1/2` each blueprint in a book. Returns the summaries, books flattened.
   */
  addExternal(prefix: string, text: string): { version?: string; book?: string; designs: LibraryBlueprint[] } {
    const json = decodeBlueprintString(text);
    this.external.set(prefix, text);
    const designs: LibraryBlueprint[] = [];
    const add = (path: string, bp: BlueprintJson, book?: string) => {
      const id = `${prefix}${path}`;
      const meta = summarize(id, bp, book);
      this.externalBlueprints.set(id, { meta, blueprint: bp });
      designs.push(meta);
    };
    if (json.blueprint) add("", json.blueprint);
    if (json.blueprint_book) flattenBook(json.blueprint_book, "#", undefined, add);
    const version = gameVersion((json.blueprint ?? json.blueprint_book)?.["version"]);
    return { version, book: json.blueprint_book?.label ?? (json.blueprint_book ? "book" : undefined), designs };
  }

  addGenerated(layout: GeneratedLayout): string {
    const id = `gen:${this.nextGenerated++}`;
    this.generated.set(id, layout);
    return id;
  }

  async list(playerIndex?: number): Promise<LibraryBlueprint[]> {
    const inGame = await this.game.call("list_blueprints", { player_index: playerIndex });
    return [...inGame, ...[...this.repo.values()].map((r) => r.meta)];
  }

  /** Turns a design id into something the mod can load. In-game ids pass through. */
  source(id: string): BlueprintSource {
    const repo = this.repo.get(id);
    if (repo) return { kind: "string", string: encodeBlueprintString({ blueprint: repo.blueprint }) };
    const generated = this.generated.get(id);
    if (generated) return { kind: "entities", entities: generated.entities, label: generated.label };
    const external = this.externalBlueprints.get(id);
    if (external) return { kind: "string", string: encodeBlueprintString({ blueprint: external.blueprint }) };
    const whole = this.external.get(id);
    if (whole) return { kind: "string", string: whole };
    if (id.startsWith("repo:") || id.startsWith("gen:")) throw new Error(`Unknown design '${id}'`);
    if (id.startsWith("fp:")) throw new Error(`Unknown design '${id}'; fetch it with get_public_blueprint first`);
    return { kind: "library", id };
  }
}
