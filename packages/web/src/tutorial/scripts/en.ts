// The English onboarding script (#51). Edit THIS file (and the tut* copy in i18n.ts)
// to change the onboarding — the components read everything from here.
//
// Stage 1 (single word, secret SHOWN first): the scramble ladder walks ocean out to
// its 100th neighbor (harbor — the start word of the board), then three gated guesses
// teach distance (desert, 200: farther, hint stays), MISS (pizza, absent), and
// improvement (boat, 50: closer, hint moves). The player then finds their way back to
// OCEAN with free typing (real vocabulary; ladder words float their real ranks).
//
// Stage 2 (unguided sentence): baker + bread, both rank maps stocked with the obvious
// bakery-context words (flour, oven, dough, pastry, …) so the likely FIRST guess lands
// on BOTH holes — the player discovers multi-hole broadcast alone.
//
// scripts.test.ts replays this file and fails if an edit breaks the lesson arc.
import type { TutorialScript } from '../script';
import { padRanks } from '../script';

const script: TutorialScript = {
  stages: [
    {
      puzzle: {
        lang: 'en',
        words: ['ocean'],
        holes: [
          {
            pos: 0,
            secret: { word: 'ocean', slug: 'ocean' },
            // The scramble demo ENDS here: the start word IS the secret's 100th
            // neighbor — which is exactly what a real round's start word is.
            start: { word: 'harbor', slug: 'harbor' },
            start_rank: 100,
          },
        ],
        ranks: {
          // Real entries double as the scramble ladder (ranks 1..5 step one by one,
          // the rest flash during the fast roll to 100) and as the exploration
          // neighborhood for the find step.
          ocean: padRanks(
            {
              ocean: { word: 'ocean', rank: 0 },
              sea: { word: 'sea', rank: 1 },
              seas: { word: 'seas', rank: 2 },
              waters: { word: 'waters', rank: 3 },
              tide: { word: 'tide', rank: 4 },
              waves: { word: 'waves', rank: 5 },
              coast: { word: 'coast', rank: 6 },
              gulf: { word: 'gulf', rank: 7 },
              coral: { word: 'coral', rank: 8 },
              bay: { word: 'bay', rank: 9 },
              beach: { word: 'beach', rank: 10 },
              sailor: { word: 'sailor', rank: 12 },
              fishing: { word: 'fishing', rank: 18 },
              shore: { word: 'shore', rank: 25 },
              island: { word: 'island', rank: 33 },
              storm: { word: 'storm', rank: 42 },
              boat: { word: 'boat', rank: 50 },
              river: { word: 'river', rank: 61 },
              wind: { word: 'wind', rank: 72 },
              salt: { word: 'salt', rank: 85 },
              harbor: { word: 'harbor', rank: 100 },
              desert: { word: 'desert', rank: 200 },
            },
            100,
          ),
        },
      },
      steps: [
        {
          kind: 'mix',
          copyKey: 'tutMixIntro',
          stops: [
            { rank: 1, labelKey: 'tutMix', copyKey: 'tutMixed1' },
            { rank: 10, labelKey: 'tutMixAgain', copyKey: 'tutMixed10' },
            { rank: 100, labelKey: 'tutMixMore' },
          ],
        },
        // The feedback teaches; each guess rolls straight into the next prompt.
        { kind: 'guess', expect: 'desert', copyKey: 'tutGuessFar' },
        { kind: 'guess', expect: 'music', copyKey: 'tutGuessMiss' },
        { kind: 'guess', expect: 'boat', copyKey: 'tutGuessCloser' },
        { kind: 'find', target: 'ocean', copyKey: 'tutFind', nudgeKey: 'tutFindNudge' },
      ],
    },
    {
      puzzle: {
        lang: 'en',
        words: ['the', 'baker', 'sells', 'warm', 'bread'],
        holes: [
          {
            pos: 1,
            secret: { word: 'baker', slug: 'baker' },
            start: { word: 'cook', slug: 'cook' },
            start_rank: 40,
          },
          {
            pos: 4,
            secret: { word: 'bread', slug: 'bread' },
            start: { word: 'cake', slug: 'cake' },
            start_rank: 25,
          },
        ],
        ranks: {
          // Both maps carry the same obvious context words (and each other's secret),
          // so whatever bakery word comes to mind first lands on BOTH holes.
          baker: padRanks(
            {
              baker: { word: 'baker', rank: 0 },
              bakery: { word: 'bakery', rank: 3 },
              flour: { word: 'flour', rank: 4 },
              bread: { word: 'bread', rank: 6 },
              pastry: { word: 'pastry', rank: 8 },
              oven: { word: 'oven', rank: 9 },
              dough: { word: 'dough', rank: 11 },
              croissant: { word: 'croissant', rank: 15 },
              cake: { word: 'cake', rank: 19 },
              butter: { word: 'butter', rank: 22 },
              wheat: { word: 'wheat', rank: 30 },
              cook: { word: 'cook', rank: 40 },
            },
            100,
          ),
          bread: padRanks(
            {
              bread: { word: 'bread', rank: 0 },
              croissant: { word: 'croissant', rank: 5 },
              dough: { word: 'dough', rank: 6 },
              flour: { word: 'flour', rank: 7 },
              pastry: { word: 'pastry', rank: 9 },
              bakery: { word: 'bakery', rank: 10 },
              oven: { word: 'oven', rank: 12 },
              wheat: { word: 'wheat', rank: 14 },
              butter: { word: 'butter', rank: 16 },
              baker: { word: 'baker', rank: 18 },
              toast: { word: 'toast', rank: 20 },
              cake: { word: 'cake', rank: 25 },
              cook: { word: 'cook', rank: 35 },
            },
            100,
          ),
        },
      },
      steps: [
        // Solving it ends the tutorial: score + PLAY TODAY'S PUZZLE, no more talk.
        { kind: 'play', copyKey: 'tutSentence' },
      ],
    },
  ],
};

export default script;
