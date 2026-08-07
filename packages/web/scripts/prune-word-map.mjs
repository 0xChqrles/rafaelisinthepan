#!/usr/bin/env node
// Prune a #154 single-word artifact down to what the onboarding tutorial embeds (#155).
//
// The tutorial plays on a REAL neighborhood — it has to, since the route map (#117) only
// opens where the #115 geometry exists (`hasRoute` gates on the rank-1 group's `dq`), and
// the hand-authored map it used before carried none. But a generated artifact is the whole
// top-10 000 groups: ~20-25k alias keys, ~1-1.5 MB, and every byte of it would ship in the
// main bundle for a screen a player sees once.
//
// What the tutorial actually needs is small and exactly definable:
//   - the word itself (rank 0);
//   - the ROAD ZONE — every group generation stamped a `road` on, which for a word artifact
//     is the flat top-ROAD_TOP (250 since 2026-08-07, 150 before it). That zone IS the map:
//     `buildRoute` draws the near field out to the farthest road, so anything past it would
//     be invisible anyway. Which means the ZONE IS WHATEVER THE INPUT ARTIFACT CARRIES, not
//     whatever ROAD_TOP says today: the committed <lang>.word.json files were generated at
//     150 and re-running the recipe now produces a longer board (see each script's header).
//     This script neither imposes nor checks a size — it copies the roads it is handed;
//   - the scripted guided words (`--keep`), which are deliberately outside the zone: the
//     "far" guess of the lesson has to rank FARTHER than the start word.
// A kept word brings its whole GROUP (every alias key at that rank), because `word`/`rank`/
// `dq`/`road` are group properties and half a group is not a thing the schema describes.
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
//     --keep forest --keep boat

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
    } else if (flag === '--keep') {
      if (!value) throw new Error('--keep needs a word');
      args.keep.push(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.in || !args.out) throw new Error('--in and --out are required');
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

// Insertion order is the artifact's own, i.e. closest-first — which `hasRoute` relies on to
// answer from the first rank-1 key it meets instead of walking the map.
const ranks = {};
for (const [key, entry] of Object.entries(artifact.ranks)) {
  if (entry.rank === 0 || entry.road !== undefined || keptRanks.has(entry.rank)) {
    ranks[key] = entry;
  }
}

writeFileSync(args.out, `${JSON.stringify({ ...artifact, ranks }, null, 0)}\n`);

const groups = new Set(Object.values(ranks).map((e) => e.rank));
console.log(
  `${args.out}: ${groups.size} groups, ${Object.keys(ranks).length} keys ` +
    `(from ${Object.keys(artifact.ranks).length})`,
);
