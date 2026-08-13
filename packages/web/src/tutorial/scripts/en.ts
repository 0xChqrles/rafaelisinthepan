// The English onboarding script (#51, re-arced by #155; rarity ending 2026-08-11). Edit
// THIS file (and the tut* copy in i18n.ts) to change the onboarding — the components read
// everything from here.
//
// The board is a REAL neighborhood: `en.word.json` is the #154 single-word artifact for
// OCEAN, pruned to what the tutorial needs. Regenerate it with (both from the REPO ROOT):
//
//   pnpm gen:word ocean --lang en
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.word.json --top 150 --keep forest
//
// (the prune keeps the word, the top-150 groups — the committed zone, sized so the mix
// ladder and the free find have a real near field to play on — and the groups of the
// `--keep` words, which is how the "far" guess survives being outside that zone).
//
// The committed map predates #163's `freq` and still shows it: none of its entries carry
// the field, which is fine — the tutorial's ladder teaches the GRADES, not this board's
// data.
//
// OCEAN was picked over LIGHTHOUSE, the first candidate. Clarity beats en/fr symmetry
// (#155) — the two languages do not share a word.
//
// The arc: the scramble ladder walks OCEAN out to its 96th neighbor (port — the start word
// of the board, inside generation's own 50-150 start band), then three gated guesses teach
// distance (forest, 214: farther, hint stays), MISS (violin, which the real map does not
// rank at all), and improvement (boat, 45: closer, hint moves). The player then finds
// their way back to OCEAN with free typing, and the ending states the game's other core
// concept — word RARITY, the five-grade ladder — before PLAY ends the lesson.
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
    // The ending: the second core concept — every word has a RARITY, said over the five-
    // grade ladder — then PLAY.
    { kind: 'rarity', introCopyKey: 'tutRarityIntro', ladderCopyKey: 'tutRarity' },
  ],
};

export default script;
