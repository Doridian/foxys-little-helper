// One conversation per player. A request runs the tool loop to completion; follow-up
// messages (answers to the helper's questions, new requests) continue the same history.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { toFactorioRichText } from "./chat-format.ts";
import type { Config } from "./config.ts";
import { COMPACTION_INSTRUCTIONS, CONTEXT_BETAS, contextManagement, isCompaction, shouldCompact } from "./context.ts";
import type { DesignStore } from "./designs.ts";
import type { GameClient } from "./game.ts";
import type { PlannerService } from "./planner/service.ts";
import { createTools } from "./tools.ts";
import type { Transcript } from "./transcript.ts";

const SYSTEM_PROMPT = `You are Foxie's Little Helper, an assistant living inside a multiplayer Factorio 2.0 game (possibly with the Space Age expansion). Players talk to you through in-game chat or the ask window.

You play fair. You only know and do what a player on your force could through the map and remote view: charted areas, live details where there is radar coverage or a player nearby, placing ghosts for construction robots, ordering deconstruction, changing recipes, and handing out blueprints. Your tools enforce this; if a tool says an area is not visible, tell the player what coverage is missing rather than guessing. Never suggest cheats or console commands.

Investigating: use the tools before answering. Start broad (game_info, production, status_summary), then drill into specific entities. When diagnosing a stuck factory, follow the shortage upstream until you find the root cause (missing input, full output, power, a broken belt, spoilage, etc.). When explaining how items flow, check inserter directions (the \`moves\` / pickup / drop fields) rather than assuming from layout.

Finding things in the factory: for anything not right in front of the player ("where do we make X?", "what's broken?", "the Gleba science build"), start with factory_overview or search_factory, then describe_block on the best match, then drill into its problem areas with status_summary, find_entities and inspect_entity. Don't scan large areas or whole surfaces with find_entities. The index can lag the live game a little and only has statuses for areas that were visible, so confirm live details before acting on them. If the index is unavailable, fall back to status_summary.

Planning: for production requests ("increase X to N/min"), use plan_production rather than doing ratio math yourself. Compare the plan with \`current\` to find the real gap: if existing machines are starved or blocked, adding more will not help, so say what is actually limiting. Mention the inputs the new line needs and whether current production of them can cover it.

Places: players refer to parts of the factory by name ("the iron bus", "Gleba science"). Resolve such names with list_places (map tags players placed and places named through you) before searching the map. When a player names something ("this is the Gleba science build", "call this the iron bus"), save it with remember_place: use the area they marked if there is one, otherwise what you were just discussing, otherwise their position (game_info); ask if it's unclear what they mean. Add a short note on what it is. Refer to known places by name in replies.

Building:
- Every build goes through propose_build: the player sees a preview and decides (Build / Blueprint / Reject buttons, or by answering you, then resolve_proposal). Never resolve a proposal as approved unless the player said yes to it.
- Pick a design: an existing blueprint (list_blueprints), a copy of something already working in their factory (copy_area, "one more of these"), or generate_layout when nothing fits.
- Pick a spot: the area the player marked with the area tool if there is one (it arrives as context), otherwise find_space near where the inputs are, and say where it is with a [gps] link.
- Report what the proposal summary says matters: blocked spots, missing items in the robot network, no robot coverage, and how to connect inputs, outputs and power.
- If the player asks for a blueprint to place themselves, use give_blueprint.
- deconstruct is destructive: unless the player asked for exactly that, describe what would go and get a yes first. undo reverts your last actions.

Your replies are shown in Factorio chat and the ask window:
- Keep them short: lead with the answer in one or two sentences, then at most a few short lines of supporting detail. Don't narrate what you checked.
- Factorio does not render markdown: no **bold**, headings, tables or code blocks. Use plain lines (a "- " list is fine); for emphasis use [font=default-bold]text[/font] sparingly.
- Use Factorio rich text to make them useful: [item=electronic-circuit], [fluid=water], [entity=assembling-machine-2], and clickable map pings [gps=x,y,surface] (e.g. [gps=12.5,-40,nauvis]).
- If the request is ambiguous, ask one short clarifying question; the player's next message will be the answer.`;

/** Short progress text for the player's FLH panel while a tool runs. */
const TOOL_STATUS: Record<string, string> = {
  game_info: "Looking around…",
  production: "Reading production stats…",
  status_summary: "Checking machines…",
  find_entities: "Looking at the area…",
  inspect_entity: "Inspecting…",
  lookup_recipes: "Looking up recipes…",
  plan_production: "Planning production…",
  factory_overview: "Surveying the factory…",
  search_factory: "Searching the factory…",
  describe_block: "Looking at a block…",
  list_blueprints: "Browsing blueprints…",
  add_library_chest: "Adding blueprint library…",
  generate_layout: "Designing a layout…",
  find_space: "Looking for space…",
  propose_build: "Preparing a preview…",
  resolve_proposal: "Placing ghosts…",
  give_blueprint: "Making a blueprint…",
  deconstruct: "Marking for deconstruction…",
  set_recipe: "Changing recipe…",
  undo: "Undoing…",
  list_places: "Looking up places…",
  remember_place: "Noting that down…",
  forget_place: "Forgetting a place…",
};

interface Conversation {
  index: number;
  player: string;
  history: BetaMessageParam[];
  abort?: AbortController;
  /** Set while the queue is being worked through; one drain per player at a time. */
  draining?: Promise<void>;
  queue: string[];
  /** Things that happened since the last request (area marked, proposal approved...). */
  notes: string[];
  tools: ReturnType<typeof createTools>;
}

export class Agent {
  private readonly client = new Anthropic();
  private readonly conversations = new Map<number, Conversation>();

  constructor(
    private readonly game: GameClient,
    private readonly config: Config,
    private readonly planner: PlannerService,
    private readonly designs: DesignStore,
    private readonly transcript: Transcript,
  ) {}

  private conversation(playerIndex: number, playerName: string): Conversation {
    let convo = this.conversations.get(playerIndex);
    if (!convo) {
      const tools = createTools({ game: this.game, planner: this.planner, designs: this.designs, playerIndex });
      convo = { index: playerIndex, player: playerName, history: [], queue: [], notes: [], tools };
      this.conversations.set(playerIndex, convo);
    }
    return convo;
  }

  cancel(playerIndex: number, playerName: string): void {
    const convo = this.conversation(playerIndex, playerName);
    convo.queue = [];
    if (convo.abort) {
      this.transcript.log({ kind: "cancel", player: playerName });
      convo.abort.abort();
      void this.say(convo, "Stopped.");
    } else {
      void this.status(convo, "done");
    }
  }

  /** Context for the player's next request, without starting a conversation turn. */
  note(playerIndex: number, playerName: string, text: string): void {
    this.conversation(playerIndex, playerName).notes.push(text);
  }

  /** Queues a message; resolves once the helper has finished with everything queued. */
  handleMessage(playerIndex: number, playerName: string, message: string): Promise<void> {
    const convo = this.conversation(playerIndex, playerName);
    convo.queue.push(`[${playerName}]: ${message}`);
    convo.draining ??= this.drain(convo).finally(() => (convo.draining = undefined));
    return convo.draining;
  }

  private async drain(convo: Conversation): Promise<void> {
    while (convo.queue.length > 0) {
      const notes = convo.notes.splice(0).map((n) => `(context: ${n})`);
      const text = [...notes, ...convo.queue.splice(0)].join("\n");
      convo.abort = new AbortController();
      await this.status(convo, "thinking", "Thinking…");
      try {
        await this.run(convo, text, convo.abort.signal);
      } catch (err) {
        if (convo.abort.signal.aborted) {
          // History may end mid tool-loop; start fresh rather than replay a broken transcript.
          convo.history = [];
        } else {
          console.error(`[agent] player ${convo.index}:`, err);
          this.transcript.log({ kind: "error", player: convo.player, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
          await this.say(convo, `Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        convo.abort = undefined;
      }
    }
    await this.status(convo, "done");
  }

  private async run(convo: Conversation, text: string, signal: AbortSignal): Promise<void> {
    const player = convo.player;
    this.transcript.log({ kind: "request", player, text });
    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.config.model,
        max_tokens: 16000,
        max_iterations: this.config.maxIterations,
        output_config: { effort: this.config.effort },
        // Automatic caching for the growing conversation, plus a fixed breakpoint after the system
        // prompt (tools + system) that still hits after a compaction or tool-result clearing.
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01", ...CONTEXT_BETAS],
        fallbacks: "default",
        context_management: contextManagement(),
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: convo.tools,
        messages: [...convo.history, { role: "user", content: text }],
      },
      { signal },
    );

    // Log every message the runner adds to the history (model turns and tool results) as it goes.
    // A compaction swaps in a new array that starts with the compaction block.
    let logged = convo.history.length + 1;
    let loggedArray = runner.params.messages;
    const flush = () => {
      const messages = runner.params.messages;
      if (messages !== loggedArray) [logged, loggedArray] = [0, messages];
      for (; logged < messages.length; logged++) this.transcript.log({ kind: "message", player, message: messages[logged]! });
    };

    let compacting = false;
    try {
      for await (const message of runner) {
        flush();
        this.transcript.log({
          kind: "usage",
          player,
          usage: message.usage,
          stop_reason: message.stop_reason,
          context_management: message.context_management ?? undefined,
          input_transformations: message.input_transformations?.length ? message.input_transformations : undefined,
          compaction: isCompaction(message) || undefined,
        });
        if (isCompaction(message)) {
          compacting = false;
          continue;
        }
        // History stays append-only on our side; the server summarises it once it gets big (see context.ts).
        if (!compacting && shouldCompact(message)) {
          compacting = true;
          runner.compactBeforeNextTurn({ type: "summarize", instructions: COMPACTION_INSTRUCTIONS });
        }
        if (message.stop_reason === "refusal") {
          await this.say(convo, "I can't help with that one.");
          continue;
        }
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim() !== "") await this.say(convo, block.text.trim());
        }
        const tools = message.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : []));
        if (tools.length > 0) await this.status(convo, "thinking", TOOL_STATUS[tools[0]!] ?? "Working…");
      }
    } finally {
      flush();
    }
    convo.history = [...runner.params.messages];
  }

  private async status(convo: Conversation, state: "thinking" | "done", detail?: string): Promise<void> {
    try {
      await this.game.call("set_status", { player_index: convo.index, state, detail });
    } catch (err) {
      console.error("[agent] failed to update status:", err);
    }
  }

  private async say(convo: Conversation, message: string): Promise<void> {
    try {
      await this.game.call("say", { message: toFactorioRichText(message), player_index: convo.index });
    } catch (err) {
      console.error("[agent] failed to send chat message:", err);
    }
  }
}
