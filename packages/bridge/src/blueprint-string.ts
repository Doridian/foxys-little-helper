// Factorio blueprint exchange strings: "0" + base64(zlib(JSON)).
import { deflateSync, inflateSync } from "node:zlib";
import type { BlueprintEntityData, Position } from "@flh/protocol";

export interface BlueprintJson {
  label?: string;
  description?: string;
  entities?: BlueprintEntityData[];
  tiles?: { name: string; position: Position }[];
  [key: string]: unknown;
}

export interface BookJson {
  label?: string;
  blueprints?: { index: number; blueprint?: BlueprintJson; blueprint_book?: BookJson }[];
  [key: string]: unknown;
}

export type ExchangeJson = { blueprint?: BlueprintJson; blueprint_book?: BookJson; [key: string]: unknown };

export function decodeBlueprintString(text: string): ExchangeJson {
  const trimmed = text.trim();
  if (!trimmed.startsWith("0")) throw new Error("Unsupported blueprint string version");
  return JSON.parse(inflateSync(Buffer.from(trimmed.slice(1), "base64")).toString("utf8")) as ExchangeJson;
}

export function encodeBlueprintString(json: ExchangeJson): string {
  return "0" + deflateSync(Buffer.from(JSON.stringify(json), "utf8"), { level: 9 }).toString("base64");
}
