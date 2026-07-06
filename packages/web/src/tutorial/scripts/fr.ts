// The French onboarding script (#51) — same two-stage lesson arc as en.ts (see the
// header there). French extras it teaches for free: accented display words are typed
// UNACCENTED (désert -> desert, océan -> ocean), which the find step forces.
import type { TutorialScript } from '../script';
import { padRanks } from '../script';

const script: TutorialScript = {
  stages: [
    {
      puzzle: {
        lang: 'fr',
        words: ['océan'],
        holes: [
          {
            pos: 0,
            secret: { word: 'océan', slug: 'ocean' },
            start: { word: 'port', slug: 'port' },
            start_rank: 100,
          },
        ],
        ranks: {
          ocean: padRanks(
            {
              ocean: { word: 'océan', rank: 0 },
              mer: { word: 'mer', rank: 1 },
              mers: { word: 'mers', rank: 2 },
              eaux: { word: 'eaux', rank: 3 },
              maree: { word: 'marée', rank: 4 },
              vagues: { word: 'vagues', rank: 5 },
              corail: { word: 'corail', rank: 8 },
              marin: { word: 'marin', rank: 12 },
              peche: { word: 'pêche', rank: 18 },
              rivage: { word: 'rivage', rank: 25 },
              ile: { word: 'île', rank: 33 },
              tempete: { word: 'tempête', rank: 42 },
              bateau: { word: 'bateau', rank: 50 },
              fleuve: { word: 'fleuve', rank: 61 },
              vent: { word: 'vent', rank: 72 },
              sel: { word: 'sel', rank: 85 },
              port: { word: 'port', rank: 100 },
              desert: { word: 'désert', rank: 200 },
            },
            100,
          ),
        },
      },
      steps: [
        { kind: 'scramble', copyKey: 'tutScramble', afterKey: 'tutAfterScramble' },
        { kind: 'guess', expect: 'desert', copyKey: 'tutGuessFar', afterKey: 'tutAfterFar' },
        { kind: 'guess', expect: 'pizza', copyKey: 'tutGuessMiss', afterKey: 'tutAfterMiss' },
        { kind: 'guess', expect: 'bateau', copyKey: 'tutGuessCloser', afterKey: 'tutAfterCloser' },
        {
          kind: 'find',
          target: 'ocean',
          copyKey: 'tutFind',
          nudgeKey: 'tutFindNudge',
          afterKey: 'tutAfterFind',
        },
      ],
    },
    {
      puzzle: {
        lang: 'fr',
        words: ['le', 'boulanger', 'vend', 'du', 'pain', 'chaud'],
        holes: [
          {
            pos: 1,
            secret: { word: 'boulanger', slug: 'boulanger' },
            start: { word: 'cuisinier', slug: 'cuisinier' },
            start_rank: 40,
          },
          {
            pos: 4,
            secret: { word: 'pain', slug: 'pain' },
            start: { word: 'gâteau', slug: 'gateau' },
            start_rank: 25,
          },
        ],
        ranks: {
          boulanger: padRanks(
            {
              boulanger: { word: 'boulanger', rank: 0 },
              boulangerie: { word: 'boulangerie', rank: 3 },
              farine: { word: 'farine', rank: 4 },
              pain: { word: 'pain', rank: 6 },
              patisserie: { word: 'pâtisserie', rank: 8 },
              four: { word: 'four', rank: 9 },
              pate: { word: 'pâte', rank: 11 },
              croissant: { word: 'croissant', rank: 15 },
              gateau: { word: 'gâteau', rank: 19 },
              beurre: { word: 'beurre', rank: 22 },
              ble: { word: 'blé', rank: 30 },
              cuisinier: { word: 'cuisinier', rank: 40 },
            },
            100,
          ),
          pain: padRanks(
            {
              pain: { word: 'pain', rank: 0 },
              croissant: { word: 'croissant', rank: 5 },
              pate: { word: 'pâte', rank: 6 },
              farine: { word: 'farine', rank: 7 },
              patisserie: { word: 'pâtisserie', rank: 9 },
              boulangerie: { word: 'boulangerie', rank: 10 },
              four: { word: 'four', rank: 12 },
              ble: { word: 'blé', rank: 14 },
              beurre: { word: 'beurre', rank: 16 },
              boulanger: { word: 'boulanger', rank: 18 },
              tartine: { word: 'tartine', rank: 20 },
              gateau: { word: 'gâteau', rank: 25 },
              cuisinier: { word: 'cuisinier', rank: 35 },
            },
            100,
          ),
        },
      },
      steps: [
        { kind: 'tell', anchor: 'center', copyKey: 'tutSentence' },
        { kind: 'play' },
        { kind: 'tell', anchor: 'watermark', copyKey: 'tutWrapTries' },
        { kind: 'tell', anchor: 'progress', copyKey: 'tutWrapProgress' },
      ],
    },
  ],
};

export default script;
