// One conversation per player. A request runs the tool loop to completion; follow-up
// messages (answers to the helper's questions, new requests) continue the same history.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Config } from "./config.ts";
import type { GameClient } from "./game.ts";
import type { PlannerService } from "./planner/service.ts";
import { createTools } from "./tools.ts";
import type { Transcript } from "./transcript.ts";

const SYSTEM_PROMPT = `You are Foxie's Little Helper, an assistant living inside a multiplayer Factorio 2.0 game (possibly with the Space Age expansion). Players talk to you through in-game chat.

You play fair. You only know what a player on your force could know through the map and remote view: charted areas, plus live details where there is radar coverage or a player nearby. Your tools enforce this; if a tool says an area is not visible, tell the player what coverage is missing rather than guessing. Never suggest cheats or console commands.

Right now you can observe and plan, but not build or act. Use the tools to investigate before answering: start broad (game_info, production, status_summary), then drill into specific entities. When diagnosing a stuck factory, follow the shortage upstream until you find the root cause (missing input, full output, power, a broken belt, spoilage, etc.).

For production requests ("increase X to N/min"), use plan_production rather than doing ratio math yourself. Compare the plan with \`current\` to find the real gap: if existing machines are starved or blocked, adding more will not help, so say what is actually limiting. Mention the inputs the new line needs and whether current production of them can cover it.

Your replies are shown in the Factorio chat window:
- Keep them short: lead with the answer in one or two sentences, then at most a few short lines of supporting detail. No markdown headings, tables or code blocks. Don't narrate what you checked.
- Use Factorio rich text to make them useful: [item=electronic-circuit], [fluid=water], [entity=assembling-machine-2], and clickable map pings [gps=x,y,surface] (e.g. [gps=12.5,-40,nauvis]).
- If the request is ambiguous, ask one short clarifying question; the player's next message will be the answer.`;

interface Conversation {
  player: string;
  history: BetaMessageParam[];
  abort?: AbortController;
  queue: string[];
}

export class Agent {
  private readonly client = new Anthropic();
  private readonly tools;
  private readonly conversations = new Map<number, Conversation>();

  constructor(
    private readonly game: GameClient,
    private readonly config: Config,
    planner: PlannerService,
    private readonly transcript: Transcript,
  ) {
    this.tools = createTools(game, planner);
  }

  private conversation(playerIndex: number, playerName: string): Conversation {
    let convo = this.conversations.get(playerIndex);
    if (!convo) {
      convo = { player: playerName, history: [], queue: [] };
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
      void this.say(`Stopped, ${playerName}.`);
    }
  }

  handleMessage(playerIndex: number, playerName: string, message: string): void {
    const convo = this.conversation(playerIndex, playerName);
    convo.queue.push(`[${playerName}]: ${message}`);
    if (!convo.abort) void this.drain(playerIndex, convo);
  }

  private async drain(playerIndex: number, convo: Conversation): Promise<void> {
    while (convo.queue.length > 0) {
      const text = convo.queue.splice(0).join("\n");
      convo.abort = new AbortController();
      try {
        await this.run(convo, text, convo.abort.signal);
      } catch (err) {
        if (convo.abort.signal.aborted) {
          // History may end mid tool-loop; start fresh rather than replay a broken transcript.
          convo.history = [];
        } else {
          console.error(`[agent] player ${playerIndex}:`, err);
          this.transcript.log({ kind: "error", player: convo.player, error: err instanceof Error ? err.stack ?? err.message : String(err) });
          await this.say(`Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        convo.abort = undefined;
      }
    }
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
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        tools: this.tools,
        messages: [...convo.history, { role: "user", content: text }],
      },
      { signal },
    );

    // Log every message the runner adds to the history (model turns and tool results) as it goes.
    let logged = convo.history.length + 1;
    const flush = () => {
      const messages = runner.params.messages;
      for (; logged < messages.length; logged++) this.transcript.log({ kind: "message", player, message: messages[logged]! });
    };

    try {
      for await (const message of runner) {
        flush();
        this.transcript.log({ kind: "usage", player, usage: message.usage, stop_reason: message.stop_reason });
        if (message.stop_reason === "refusal") {
          await this.say("I can't help with that one.");
          continue;
        }
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim() !== "") await this.say(block.text.trim());
        }
      }
    } finally {
      flush();
    }
    convo.history = [...runner.params.messages];
  }

  private async say(message: string): Promise<void> {
    try {
      await this.game.call("say", { message });
    } catch (err) {
      console.error("[agent] failed to send chat message:", err);
    }
  }
}
