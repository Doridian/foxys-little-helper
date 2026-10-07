import { GameEvent } from "@flh/protocol";

declare global {
  const storage: {
    events?: GameEvent[];
  };
}
