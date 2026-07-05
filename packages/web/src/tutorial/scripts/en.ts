// The English onboarding script (#51). Edit THIS file (and the tut* copy in i18n.ts)
// to change the onboarding — the components read everything from here. The guess
// sequence must keep the lesson arc scripts.test.ts asserts:
//   pizza -> MISS on both holes        (every guess is tested on every hole)
//   water -> improves BOTH holes       (context, not synonyms)
//   boat  -> solves hole 1, warm-but-  (solving locks; a hole keeps your closest word)
//            no-improve on hole 2
//   ocean -> solves hole 2             (solved holes stay silent)
import type { TutorialScript } from '../script';
import { padRanks } from '../script';

const script: TutorialScript = {
  puzzle: {
    lang: 'en',
    words: ['the', 'little', 'boat', 'drifts', 'across', 'the', 'ocean'],
    holes: [
      {
        pos: 2,
        secret: { word: 'boat', slug: 'boat' },
        start: { word: 'canoe', slug: 'canoe' },
        start_rank: 60,
      },
      {
        pos: 6,
        secret: { word: 'ocean', slug: 'ocean' },
        start: { word: 'lake', slug: 'lake' },
        start_rank: 74,
      },
    ],
    ranks: {
      boat: padRanks(
        {
          boat: { word: 'boat', rank: 0 },
          water: { word: 'water', rank: 35 },
          canoe: { word: 'canoe', rank: 60 },
        },
        100,
      ),
      ocean: padRanks(
        {
          ocean: { word: 'ocean', rank: 0 },
          water: { word: 'water', rank: 15 },
          boat: { word: 'boat', rank: 25 },
          lake: { word: 'lake', rank: 74 },
        },
        100,
      ),
    },
  },
  steps: [
    { kind: 'tell', anchor: 'center', copyKey: 'tutIntro' },
    { kind: 'tell', anchor: 'hole', copyKey: 'tutHoles' },
    { kind: 'guess', expect: 'pizza', copyKey: 'tutGuessFar', afterKey: 'tutAfterFar' },
    { kind: 'guess', expect: 'water', copyKey: 'tutGuessWarm', afterKey: 'tutAfterWarm' },
    { kind: 'guess', expect: 'boat', copyKey: 'tutGuessSolveOne', afterKey: 'tutAfterSolveOne' },
    { kind: 'guess', expect: 'ocean', copyKey: 'tutGuessSolveAll', afterKey: 'tutAfterSolveAll' },
    { kind: 'tell', anchor: 'watermark', copyKey: 'tutWrapTries' },
    { kind: 'tell', anchor: 'progress', copyKey: 'tutWrapProgress' },
  ],
};

export default script;
