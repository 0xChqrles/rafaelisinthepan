// The French onboarding script (#51) — same lesson arc as en.ts (see the header
// there). Two extras the French sentence teaches for free: the second hole lives
// inside the elision "l'océan" (prefix affix on display), and the secret carries an
// accent the player types WITHOUT (fold: océan -> ocean).
import type { TutorialScript } from '../script';
import { padRanks } from '../script';

const script: TutorialScript = {
  puzzle: {
    lang: 'fr',
    words: ['le', 'petit', 'bateau', 'dérive', 'sur', "l'océan"],
    holes: [
      {
        pos: 2,
        secret: { word: 'bateau', slug: 'bateau' },
        start: { word: 'canoë', slug: 'canoe' },
        start_rank: 60,
      },
      {
        pos: 5,
        secret: { word: 'océan', slug: 'ocean' },
        start: { word: 'lac', slug: 'lac' },
        start_rank: 74,
        prefix: "l'",
      },
    ],
    ranks: {
      bateau: padRanks(
        {
          bateau: { word: 'bateau', rank: 0 },
          eau: { word: 'eau', rank: 35 },
          canoe: { word: 'canoë', rank: 60 },
        },
        100,
      ),
      ocean: padRanks(
        {
          ocean: { word: 'océan', rank: 0 },
          eau: { word: 'eau', rank: 15 },
          bateau: { word: 'bateau', rank: 25 },
          lac: { word: 'lac', rank: 74 },
        },
        100,
      ),
    },
  },
  steps: [
    { kind: 'tell', anchor: 'center', copyKey: 'tutIntro' },
    { kind: 'tell', anchor: 'hole', copyKey: 'tutHoles' },
    { kind: 'guess', expect: 'pizza', copyKey: 'tutGuessFar', afterKey: 'tutAfterFar' },
    { kind: 'guess', expect: 'eau', copyKey: 'tutGuessWarm', afterKey: 'tutAfterWarm' },
    { kind: 'guess', expect: 'bateau', copyKey: 'tutGuessSolveOne', afterKey: 'tutAfterSolveOne' },
    { kind: 'guess', expect: 'ocean', copyKey: 'tutGuessSolveAll', afterKey: 'tutAfterSolveAll' },
    { kind: 'tell', anchor: 'watermark', copyKey: 'tutWrapTries' },
    { kind: 'tell', anchor: 'progress', copyKey: 'tutWrapProgress' },
  ],
};

export default script;
