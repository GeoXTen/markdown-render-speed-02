// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from /input/cases.json (a JSON array of
// { id, markdown }), renders each markdown string with parse() from
// ./parse.js, and writes the HTML strings, in the same order, as a JSON
// array to /output/html.json. When run outside the grading container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override the two directories.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
