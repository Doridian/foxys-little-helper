// Connects the pure planner to the live game: caches prototype data, fetches research state
// and surface properties, and annotates plans with current production and existing machines.

import type { ForceRecipeState } from "@flh/protocol";
import type { GameClient } from "../game.ts";
import { PlannerData, plan, recipesFor, type Plan, type PlanRequest } from "./solver.ts";

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

export interface CurrentState {
  /** Produced/consumed per minute on the surface for every item the plan touches (10 minute average). */
  rates: { name: string; produced_per_min: number; consumed_per_min: number }[];
  /**
   * Existing machines per recipe, with status counts. Not filled in yet: the mod refuses
   * whole-surface scans (they stall big bases); the factory index will answer this.
   */
  existing_machines?: { recipe: string; count: number; statuses: Record<string, number> }[];
  existing_machines_hint?: string;
}

export class PlannerService {
  private data?: Promise<PlannerData>;

  constructor(private readonly game: GameClient) {}

  /** Drop cached prototypes, e.g. after reconnecting to a (possibly restarted) server. */
  invalidate(): void {
    this.data = undefined;
  }

  planner(): Promise<PlannerData> {
    this.data ??= this.game.call("prototypes", {}).then((d) => new PlannerData(d));
    this.data.catch(() => (this.data = undefined));
    return this.data;
  }

  force(): Promise<ForceRecipeState> {
    return this.game.call("force_recipes", {});
  }

  async plan(
    surface: string,
    req: Omit<PlanRequest, "surface">,
  ): Promise<{ plan: Plan; current: CurrentState | { unavailable: string } }> {
    const [data, force, surfaceInfo] = await Promise.all([
      this.planner(),
      this.force(),
      this.game.call("surface_info", { surface }),
    ]);
    const result = plan(data, force, { ...req, surface: surfaceInfo });
    // Live state needs a charted surface; planning for a planet not visited yet still works without it.
    const current = await this.current(surface, result).catch((err: Error) => ({ unavailable: err.message }));
    return { plan: roundPlan(result), current };
  }

  async recipes(item: string) {
    const [data, force] = await Promise.all([this.planner(), this.force()]);
    return recipesFor(data, force, item);
  }

  private async current(surface: string, p: Plan): Promise<CurrentState> {
    const items = new Set<string>([p.item]);
    for (const s of p.steps) for (const x of [...s.inputs, ...s.outputs]) items.add(x.name);

    const rates = await this.game.call("production", { surface, items: [...items], window: "10m" });
    return {
      rates: rates.map((r) => ({ name: r.name, produced_per_min: round(r.produced_per_min), consumed_per_min: round(r.consumed_per_min) })),
      existing_machines_hint: "Use search_factory to find existing machines for these recipes",
    };
  }
}

function roundPlan(p: Plan): Plan {
  const rates = (list: { name: string; rate: number }[]) => list.map((x) => ({ name: x.name, rate: round(x.rate) }));
  return {
    ...p,
    steps: p.steps.map((s) => ({
      ...s,
      machines: round(s.machines),
      crafts_per_min: round(s.crafts_per_min),
      speed: round(s.speed),
      productivity: round(s.productivity),
      power_kw: round(s.power_kw),
      inputs: rates(s.inputs),
      outputs: rates(s.outputs),
    })),
    raw_inputs: rates(p.raw_inputs),
    byproducts: rates(p.byproducts),
    mining: p.mining.map((m) => ({ ...m, rate: round(m.rate), drills: m.drills === undefined ? undefined : round(m.drills) })),
    total_power_kw: round(p.total_power_kw),
  };
}
