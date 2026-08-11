#!/usr/bin/env node
// Prune a #154 single-word artifact down to what the onboarding tutorial embeds (#155).
//
// The tutorial plays on a REAL neighborhood — the mix ladder walks real ranks and the free
// find step lands on real groups. But a generated artifact is the whole top-10 000 groups:
// ~20-25k alias keys, ~1-1.5 MB, and every byte of it would ship in the main bundle for a
// screen a player sees once.
//
// What the tutorial actually needs is small and exactly definable:
//   - the word itself (rank 0);
//   - the NEAR FIELD — every group of rank <= `--top` (the committed boards use 150: it
//     comfortably contains the start band the mix demo lands in, and gives the free find a
//     real neighborhood to type against). Until 2026-08-11 the zone was "whatever carries
//     a `road`" — generation's flat clustering zone — because the ending stepped through
//     the map's roads; that ending is retired, gen:word no longer emits roads at all, and
//     the zone is now the explicit rank cut this flag states;
//   - the scripted guided words (`--keep`), which are deliberately outside the zone: the
//     "far" guess of the lesson has to rank FARTHER than the start word.
// A kept word brings its whole GROUP (every alias key at that rank), because `word`/`rank`/
// `dq`/`freq` are group properties and half a group is not a thing the schema describes.
//
// The board — which word, which start rank, which guided words — is declared ONCE, in
// src/tutorial/scripts/<lang>.ts. This script takes it on the command line, the script file
// records the exact invocation in its header, and scripts.test.ts fails if the two ever
// drift (it replays the lesson arc against the embedded map).
//
// Usage (paths are cwd-relative; the script headers record the exact repo-root invocations):
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.word.json \
//     --top 150 --keep forest

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { keep: [] };
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
    } else if (flag === '--keep') {
      if (!value) throw new Error('--keep needs a word');
      args.keep.push(value);
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

// The ranks of the groups the `--keep` words belong to. Missing means the board asks for a
// word this neighborhood does not rank at all — a scripting mistake, not something to
// silently drop (the "far" guess would then read as a MISS and teach the wrong lesson).
const keptRanks = new Set(
  args.keep.map((word) => {
    const entry = artifact.ranks[word];
    if (!entry) throw new Error(`--keep ${word}: absent from ${args.in}`);
    return entry.rank;
  }),
);

// Insertion order is the artifact's own, i.e. closest-first, which the embedded map keeps.
const ranks = {};
for (const [key, entry] of Object.entries(artifact.ranks)) {
  if (entry.rank <= args.top || keptRanks.has(entry.rank)) {
    ranks[key] = entry;
  }
}

writeFileSync(args.out, `${JSON.stringify({ ...artifact, ranks }, null, 0)}\n`);

const groups = new Set(Object.values(ranks).map((e) => e.rank));
console.log(
  `${args.out}: ${groups.size} groups, ${Object.keys(ranks).length} keys ` +
    `(from ${Object.keys(artifact.ranks).length})`,
);
