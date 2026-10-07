// RPC results that are already JSON text. Big payloads whose parts are stored as JSON (the
// factory index) splice them together instead of decoding and re-encoding every part.

export interface RawJson {
  flh_raw_json: string;
}

/** Wraps JSON text so rpc.ts sends it as the result verbatim. */
export function rawJson<T>(json: string): T {
  return { flh_raw_json: json } as RawJson as unknown as T;
}

export function isRawJson(value: unknown): value is RawJson {
  return typeof value === "object" && value !== null && typeof (value as RawJson).flh_raw_json === "string";
}
