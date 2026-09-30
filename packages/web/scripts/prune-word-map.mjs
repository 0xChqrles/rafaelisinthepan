#!/usr/bin/env node
// Prune a #154 single-word artifact down to what the onboarding tutorial embeds (#155).
//
// The tutorial plays on REAL neighborhoods — every guess lands on real groups. But a
// generated artifact is the whole top-10 000 groups:
// ~20-25k alias keys, ~1-1.5 MB, and every byte of it would ship in the main bundle for a
// screen a player sees once.
//
// What the tutorial actually needs is small and exactly definable:
//   - the word itself (rank 0);
//   - the NEAR FIELD — every group of rank <= `--top` (the committed boards use 150: it
//     contains the game's own 50–150 start band and gives the free typing a real
//     neighborhood to land on).
// A rank is kept as a whole GROUP (every alias key at that rank), because `word`/`rank`/
// `dq` are group properties and half a group is not a thing the schema describes.
//
// The board — which word, which start word — is declared ONCE, in
// src/tutorial/scripts/<lang>.ts. This script takes the word on the command line, the script
// file records the exact invocation in its header, and scripts.test.ts fails if the two ever
// drift (it checks the boards against the embedded maps).
//
// Usage (paths are cwd-relative; the script headers record the exact repo-root invocations):
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.ocean.json --top 150

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--in' || flag === '--out') {
      if (!value) throw new Error(`${flag} needs a path`);
      args[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--top') {
      const top = Number(value);
      if (!Number.isInteger(top) || top < 1) throw new Error('--top needs a positive rank');
      args.top = top;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.in || !args.out || !args.top) throw new Error('--in, --out and --top are required');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const artifact = JSON.parse(readFileSync(args.in, 'utf8'));

// Insertion order is the artifact's own, i.e. closest-first, which the embedded map keeps.
const ranks = {};
for (const [key, entry] of Object.entries(artifact.ranks)) {
  if (entry.rank <= args.top) {
    ranks[key] = entry;
  }
}

writeFileSync(args.out, `${JSON.stringify({ ...artifact, ranks }, null, 0)}\n`);

const groups = new Set(Object.values(ranks).map((e) => e.rank));
console.log(
  `${args.out}: ${groups.size} groups, ${Object.keys(ranks).length} keys ` +
    `(from ${Object.keys(artifact.ranks).length})`,
);
