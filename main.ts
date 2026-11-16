// Driver for the markdown-render-speed-02 harness.
//
// Reads a JSON array of { id, markdown } cases from `cases.json` in the
// input directory (env MAKEFUN_INPUT_DIR, default "/input"), renders every
// case with parse() from ./parse.js, and writes the resulting HTML strings
// as a JSON array, in the same order, to `html.json` in the output
// directory (env MAKEFUN_OUTPUT_DIR, default "/output").

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

  const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
  const cases = JSON.parse(raw) as Case[];

  const html: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    html[k] = parse(cases[k].markdown);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
}

main();
