// The English onboarding script (#51, re-arced by #155). Edit THIS file (and the tut* copy
// in i18n.ts) to change the onboarding — the components read everything from here.
//
// The board is a REAL neighborhood: `en.word.json` is the #154 single-word artifact for
// OCEAN, pruned to what the tutorial needs. Regenerate it with (both from the REPO ROOT):
//
//   pnpm gen:word ocean --lang en
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.word.json --keep forest
//
// (the prune keeps the word, the road zone — generation's flat top-150 for a word artifact —
// and the groups of the `--keep` words, which is how the "far" guess survives being outside
// that zone). OCEAN was picked over LIGHTHOUSE, the first candidate, on ROUTE legibility: its
// neighborhood splits into three well-populated roads a player can name at a glance — the
// coastline (sea, waters, atlantic, shores), the ocean as a system (coral, waves, currents,
// tides, reefs) and seafaring (vessel, ship, sail, voyage, whales) — where lighthouse's split
// 135/15 and the small road reads as an outlier rather than a sense. Clarity beats en/fr
// symmetry (#155), so the two languages do not share a word.
//
// The arc: the scramble ladder walks OCEAN out to its 96th neighbor (port — the start word of
// the board, inside generation's own 50-150 start band), then three gated guesses teach
// distance (forest, 214: farther, hint stays), MISS (violin, which the real map does not rank
// at all), and improvement (boat, 45: closer, hint moves). The player then finds their way
// back to OCEAN with free typing, and taps the word they found — its route line takes its
// place, and PLAY ends the lesson.
//
// scripts.test.ts replays this file and fails if an edit breaks the lesson arc.
import type { WordPuzzle } from '@whippin/shared';
import type { TutorialScript } from '../script';
import artifact from './en.word.json';

const { lang, word, ranks }: WordPuzzle = artifact;

// The departure. Its display form and rank are READ OFF the map rather than restated here,
// so the board can never disagree with its own neighborhood.
const START = 'port';

const script: TutorialScript = {
  puzzle: {
    lang,
    words: [word.word],
    holes: [
      {
        pos: 0,
        secret: word,
        // The scramble demo ENDS here: the start word IS the secret's 96th neighbor — which
        // is exactly what a real round's start word is.
        start: { word: ranks[START].word, slug: START },
        start_rank: ranks[START].rank,
      },
    ],
    ranks: { [word.slug]: ranks },
  },
  steps: [
    {
      kind: 'mix',
      copyKey: 'tutMixIntro',
      stops: [
        { rank: 1, labelKey: 'tutMix', copyKey: 'tutMixed1' },
        { rank: 10, labelKey: 'tutMixAgain', copyKey: 'tutMixed10' },
        { rank: ranks[START].rank, labelKey: 'tutMixMore' },
      ],
    },
    // The feedback teaches; each guess rolls straight into the next prompt.
    { kind: 'guess', expect: 'forest', copyKey: 'tutGuessFar' },
    { kind: 'guess', expect: 'violin', copyKey: 'tutGuessMiss' },
    { kind: 'guess', expect: 'boat', copyKey: 'tutGuessCloser' },
    { kind: 'find', target: word.slug, copyKey: 'tutFind', nudgeKey: 'tutFindNudge' },
    // The ending: tap the word you found — the routes take its place — then PLAY.
    { kind: 'tap', tapCopyKey: 'tutTap', clickCopyKey: 'tutClick', routeCopyKey: 'tutRoutes' },
  ],
};

export default script;
