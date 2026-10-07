import assert from "node:assert/strict";
import { it } from "node:test";
import { toFactorioRichText } from "./chat-format.ts";

it("converts markdown emphasis and headings to Factorio rich text", () => {
  assert.equal(
    toFactorioRichText("## Gears\n**Iron smelting (top):** the `inserter` at [gps=1,2,nauvis]\n\n\n- item"),
    "[font=default-bold]Gears[/font]\n[font=default-bold]Iron smelting (top):[/font] the inserter at [gps=1,2,nauvis]\n\n- item",
  );
});

it("leaves rich text tags and plain text alone", () => {
  const text = "[item=iron-plate] x 5 * 3 = 15, snake_case_name";
  assert.equal(toFactorioRichText(text), text);
});
