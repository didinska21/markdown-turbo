# markdown-turbo

[![Competition](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![Rank](https://make.fun/badge/markdown-render-speed-02/didinska21/markdown-turbo/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![Reward](https://make.fun/badge/markdown-render-speed-02/didinska21/markdown-turbo/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A dependency-free JavaScript Markdown renderer that produces **byte-for-byte
the same HTML as marked 18.1.3** (default options: GFM on, breaks off,
pedantic off) while rendering much faster than marked itself.

It implements the full CommonMark 0.31.2 block and inline grammars plus the
GFM 0.29 extensions: tables, task list items, strikethrough, and extended
autolinks (`www.`, bare URLs, emails, `mailto:` / `xmpp:`). Where marked's
output deviates from the written spec, marked's behaviour wins — the renderer
was tuned against the complete CommonMark + GFM example suites and against
large generated README-style documents until every case matched exactly.

## Usage

```js
import { parse } from "./parse.js";

const html = parse("# Hello\n\nSome *markdown* text.\n");
```

`parse(markdown)` is a pure function: no imports, no I/O, no clock, no
randomness, and no state shared between calls. Link reference definitions
are collected per document, as they should be.

## Harness driver

`main.ts` is the entry point the competition harness runs
(`node /bot/main.ts`). It reads a JSON array of `{ id, markdown }` cases
from `cases.json` in `MAKEFUN_INPUT_DIR` (default `/input`), renders each
case with `parse()`, and writes the HTML strings, in order, as a JSON array
to `html.json` in `MAKEFUN_OUTPUT_DIR` (default `/output`).

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## How it works

Rendering happens in two passes per document:

1. **Block lexing.** The source is split into lines once, then scanned a
   single time into block tokens (headings, paragraphs, lists, blockquotes,
   fenced/indented code, tables, HTML blocks, thematic breaks). Containers
   (blockquotes, list items) are handled by extracting their stripped line
   ranges and recursing, which keeps laziness, looseness and nesting rules
   local and exact. Link reference definitions are gathered during the same
   pass, in document order.
2. **Inline parsing.** Each block's text runs through a scanner modelled on
   the CommonMark delimiter-stack algorithm: emphasis/strong with the rule
   of 3, code spans, links and images (inline, full/collapsed/shortcut
   references), autolinks, escapes, entities, hard breaks and raw inline
   HTML. Plain-text runs take a fast path that only stops at "interesting"
   characters.

The hot paths avoid regular expressions almost entirely — line
classification, delimiter runs and flanking checks are direct character
work over pre-split lines, and HTML is built by plain string concatenation.

## Benchmarking

The practice corpus is dominated by 40 generated documents of 20–110 KB.
To compare against the marked baseline behind the same driver:

```sh
taskset -c 0 /usr/bin/time -v node main.ts   # this entry
taskset -c 0 /usr/bin/time -v node main.ts   # baseline copy, same input
```

with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` pointing both runs at the
same input. markdown-turbo renders the full 720-case practice set several
times faster than the baseline while matching its output on every case.

## License

MIT — see [LICENSE](LICENSE).
