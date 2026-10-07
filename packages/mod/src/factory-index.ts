// Factory index: per-chunk summaries of the helper force's entities (see ChunkSummary in the
// protocol), kept up to date from build/removal events plus an amortised background rescan.
// Stub: to be implemented.

import { RpcMethods } from "@flh/protocol";

export function indexStatus(): RpcMethods["index_status"]["result"] {
  throw "The factory index is not implemented yet";
}

export function indexChanges(_params: RpcMethods["index_changes"]["params"]): RpcMethods["index_changes"]["result"] {
  throw "The factory index is not implemented yet";
}
