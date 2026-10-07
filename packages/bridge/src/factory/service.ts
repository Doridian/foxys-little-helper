// Connects the factory index mirror to the live game: pulls index_changes before each factory
// query (cheap when nothing changed), re-clusters changed surfaces, and answers the factory tools.

import type { RpcMethods } from "@flh/protocol";
import type { GameClient } from "../game.ts";
import type { PlannerData } from "../planner/solver.ts";
import type { PlannerService } from "../planner/service.ts";
import { type Block, BlockIds, type ClusterOptions, DEFAULT_CLUSTER, type RecipeInfo, clusterSurface } from "./cluster.ts";
import { placesMentioned } from "../places.ts";
import { IndexMirror } from "./mirror.ts";
import { type PlaceSearch, type SearchQuery, describeBlock, overview, searchBlocks } from "./search.ts";

export class IndexUnavailableError extends Error {}

/** Don't ask the mod for changes more often than this; one request often makes several tool calls. */
const MIN_REFRESH_MS = 1000;
/** Upper bound on pages per refresh, so a busy index can't keep a tool call waiting forever. */
const MAX_PAGES = 1000;
const PAGE_SIZE = 500;

type Source = Pick<GameClient, "call">;

export class FactoryIndex {
  readonly mirror = new IndexMirror();
  private readonly ids = new BlockIds();
  private readonly blocks = new Map<string, Block[]>();
  private refreshing?: Promise<void>;
  private lastRefresh = 0;
  /** Bumped by invalidate() so a pull that was in flight doesn't write into the fresh state. */
  private generation = 0;
  private info?: RecipeInfo;
  /** The RecipeInfo the current blocks were built with; re-cluster when it changes. */
  private blocksInfo?: RecipeInfo;
  /** Set by whoever implements named places; consulted for search_factory's `text`. */
  places?: PlaceSearch;

  constructor(
    private readonly game: Source,
    private readonly planner?: Pick<PlannerService, "planner">,
    private readonly opts: ClusterOptions = DEFAULT_CLUSTER,
  ) {}

  /** Forget everything, e.g. after reconnecting to a (possibly different) server. */
  invalidate(): void {
    this.mirror.reset();
    this.blocks.clear();
    this.lastRefresh = 0;
    this.refreshing = undefined;
    this.generation++;
    this.info = undefined;
    this.blocksInfo = undefined;
  }

  /** Pull changes from the mod (all pages) unless we did so very recently. Concurrent callers share one pull. */
  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastRefresh < MIN_REFRESH_MS) return Promise.resolve();
    const generation = this.generation;
    const pull: Promise<void> = this.pull(generation)
      .then(() => {
        if (generation === this.generation) this.lastRefresh = Date.now();
      })
      .finally(() => {
        if (this.refreshing === pull) this.refreshing = undefined;
      });
    return (this.refreshing = pull);
  }

  private async pull(generation: number): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page++) {
      let result: RpcMethods["index_changes"]["result"];
      try {
        result = await this.game.call("index_changes", { since: this.mirror.revision, limit: PAGE_SIZE });
      } catch (err) {
        throw new IndexUnavailableError(
          `The factory index is unavailable (${(err as Error).message}). Fall back to status_summary and find_entities on specific areas.`,
        );
      }
      if (generation !== this.generation) return;
      try {
        this.mirror.apply(result);
      } catch {
        // Index was rebuilt on the mod side: start over from scratch.
        this.mirror.reset();
        continue;
      }
      if (!result.more) break;
    }
    const info = await this.recipeInfo();
    if (generation !== this.generation) return;
    const dirty = this.mirror.takeDirty();
    if (info !== this.blocksInfo) for (const surface of this.mirror.surfaces.keys()) dirty.add(surface);
    this.blocksInfo = info;
    for (const surface of dirty) {
      const chunks = this.mirror.surfaces.get(surface);
      if (!chunks) {
        this.blocks.delete(surface);
        this.ids.forget(surface);
        continue;
      }
      this.blocks.set(surface, clusterSurface(surface, chunks, info, this.ids, this.opts));
    }
  }

  private async recipeInfo(): Promise<RecipeInfo> {
    if (this.info) return this.info;
    let data: PlannerData | undefined;
    try {
      data = await this.planner?.planner();
    } catch {
      // Prototype data is a nicety here (recipe -> item names); don't cache the fallback.
      return fallbackInfo;
    }
    return (this.info = data ? plannerInfo(data) : fallbackInfo);
  }

  allBlocks(): Block[] {
    return [...this.blocks.values()].flat();
  }

  async status() {
    await this.refresh();
    // index_status is optional extra detail (coverage, pending rescans).
    const status = await this.game.call("index_status", {}).catch(() => undefined);
    return status;
  }

  async overview(surface?: string) {
    const status = await this.status();
    const surfaces = overview(this.allBlocks(), surface);
    return {
      index: status
        ? {
            revision: status.revision,
            surfaces: status.surfaces
              .filter((s) => !surface || s.name === surface)
              .map((s) => ({ name: s.name, chunks: s.chunks, ...(s.pending > 0 ? { pending_rescan: s.pending } : {}) })),
          }
        : { revision: this.mirror.revision, chunks: this.mirror.chunkCount },
      surfaces,
      ...(surfaces.length === 0 ? { note: "No production indexed yet (nothing built, or the index is still being built)." } : {}),
    };
  }

  async search(q: SearchQuery) {
    if (q.near && !q.surface) throw new Error("`near` needs `surface` (positions are per surface)");
    await this.refresh();
    const places = q.text && this.places ? await this.places(q.text) : [];
    const info = await this.recipeInfo();
    const results = searchBlocks(this.allBlocks(), q, (r) => info.products(r), places);
    return results.length > 0 ? results : { results: [], note: "No matching blocks. Try a broader text, another surface, or factory_overview." };
  }

  async describe(id: string) {
    await this.refresh();
    const block = this.allBlocks().find((b) => b.id === id);
    if (!block) throw new Error(`No block '${id}' (ids change only when the factory is rebuilt; search again)`);
    return describeBlock(block, this.mirror.surfaces.get(block.surface)!);
  }
}

const fallbackInfo: RecipeInfo = {
  products: (recipe) => [recipe],
  ingredients: () => [],
  mined: (resource) => [resource],
};

export function plannerInfo(data: PlannerData): RecipeInfo {
  const mined = new Map<string, string[]>();
  for (const [item, resources] of data.mined) {
    for (const r of resources) {
      let list = mined.get(r.name);
      if (!list) mined.set(r.name, (list = []));
      list.push(item);
    }
  }
  return {
    products: (recipe) => data.recipes.get(recipe)?.products.map((p) => p.name) ?? [recipe],
    ingredients: (recipe) => data.recipes.get(recipe)?.ingredients.map((i) => i.name) ?? [],
    mined: (resource) => mined.get(resource) ?? [resource],
  };
}

const instances = new WeakMap<GameClient, FactoryIndex>();

/** The one FactoryIndex per game connection, shared by all conversations. */
export function factoryIndex(game: GameClient, planner?: PlannerService): FactoryIndex {
  let index = instances.get(game);
  if (!index) {
    instances.set(game, (index = new FactoryIndex(game, planner)));
    index.places = async (text) =>
      placesMentioned(await game.call("list_places", {}), text).map((p) => ({
        name: p.name,
        surface: p.surface,
        // A map tag is a point; treat it as the chunk-sized area around it.
        area: p.area ?? {
          left_top: { x: p.position.x - 16, y: p.position.y - 16 },
          right_bottom: { x: p.position.x + 16, y: p.position.y + 16 },
        },
      }));
  }
  return index;
}
