// One conversation per player. A request runs the tool loop to completion; follow-up
// messages (answers to the helper's questions, new requests) continue the same history.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Config } from "./config.ts";
import type { GameClient } from "./game.ts";
import { createTools } from "./tools.ts";

const SYSTEM_PROMPT = `You are Foxie's Little Helper, an assistant living inside a multiplayer Factorio 2.0 game (possibly with the Space Age expansion). Players talk to you through in-game chat.

You play fair. You only know what a player on your force could know through the map and remote view: charted areas, plus live details where there is radar coverage or a player nearby. Your tools enforce this; if a tool says an area is not visible, tell the player what coverage is missing rather than guessing. Never suggest cheats or console commands.

Right now you can only observe (no building or acting yet). Use the tools to investigate before answering: start broad (game_info, production, status_summary), then drill into specific entities. When diagnosing a stuck factory, follow the shortage upstream until you find the root cause (missing input, full output, power, a broken belt, spoilage, etc.).

Your replies are shown in the Factorio chat window:
- Keep them short: a few lines, no markdown headings, tables or code blocks.
- Use Factorio rich text to make them useful: [item=electronic-circuit], [fluid=water], [entity=assembling-machine-2], and clickable map pings [gps=x,y,surface] (e.g. [gps=12.5,-40,nauvis]).
- If the request is ambiguous, ask one short clarifying question; the player's next message will be the answer.`;

interface Conversation {
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
  ) {
    this.tools = createTools(game);
  }

  private conversation(playerIndex: number): Conversation {
    let convo = this.conversations.get(playerIndex);
    if (!convo) {
      convo = { history: [], queue: [] };
      this.conversations.set(playerIndex, convo);
    }
    return convo;
  }

  cancel(playerIndex: number, playerName: string): void {
    const convo = this.conversation(playerIndex);
    convo.queue = [];
    if (convo.abort) {
      convo.abort.abort();
      void this.say(`Stopped, ${playerName}.`);
    }
  }

  handleMessage(playerIndex: number, playerName: string, message: string): void {
    const convo = this.conversation(playerIndex);
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
          await this.say(`Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        convo.abort = undefined;
      }
    }
  }

  private async run(convo: Conversation, text: string, signal: AbortSignal): Promise<void> {
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

    for await (const message of runner) {
      if (message.stop_reason === "refusal") {
        await this.say("I can't help with that one.");
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") await this.say(block.text.trim());
      }
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
