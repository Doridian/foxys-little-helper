import { Area, GameEvent, Position } from "@flh/protocol";
import { LuaEntity, LuaInventory } from "factorio:runtime";

declare global {
  interface FlhProposal {
    id: number;
    label: string;
    player_index?: number;
    surface: string;
    /** Exported (already fairness-filtered) blueprint. */
    blueprint: string;
    /** Where build_blueprint must be called to land on the previewed spot. */
    build_position: Position;
    direction: number;
    area: Area;
    entity_count: number;
    conflict_count: number;
    renders: number[];
  }

  type FlhAction =
    | { id: number; kind: "build"; surface: string; placed: { name: string; position: Position }[] }
    | { id: number; kind: "deconstruct"; entities: LuaEntity[] }
    | { id: number; kind: "recipe"; entity: LuaEntity; previous?: string };

  interface FlhRequestStatus {
    text: string;
    state: "queued" | "thinking" | "stopping";
    detail?: string;
    since: number;
  }

  const storage: {
    events?: GameEvent[];
    next_id?: number;
    proposals?: Record<number, FlhProposal>;
    actions?: FlhAction[];
    selections?: Record<number, { surface: string; area: Area; render?: number }>;
    library?: LuaEntity[];
    requests?: Record<number, FlhRequestStatus>;
    scratch?: LuaInventory;
    history?: Record<number, { from: "you" | "flh"; text: string }[]>;
  };
}
