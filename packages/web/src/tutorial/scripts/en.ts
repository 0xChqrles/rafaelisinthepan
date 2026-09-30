// The English level-1 script (#269). Edit THIS file (and the tut* copy in i18n.ts) to
// change the lesson — the components read everything from here.
//
// The boards are REAL neighborhoods, #154 single-word artifacts pruned to their top-150
// groups. Regenerate them with (from the REPO ROOT):
//
//   pnpm gen:word ocean --lang en --form ocean=n:s
//   pnpm gen:word mountain --lang en --form mountain=n:s
//   pnpm gen:word dog --lang en --form dog=n:s
//   pnpm gen:word moon --lang en --form moon=n:s
//   pnpm gen:word cat --lang en --form cat=n:s
//   pnpm gen:word liberty --lang en --form liberty=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.ocean.json --top 150
//   (and the same for mountain, dog, moon, cat and liberty)
//
// The maps are the English fastText neighborhoods (#317); the clues were re-read off them.
// THE REVEAL: OCEAN, shown, then hidden behind SEA — its closest word, rank 1 — and typed
// back. THE WORD: MOUNTAIN, never shown, behind SKI (17, the French lesson's own clue): a
// real search, intuitive clue, slopes / alps / hills / valleys all move the hole. THE
// SENTENCE: "a dog barks at the moon." — DOG behind COYOTE (63) and MOON behind STAR (69),
// the game's own 50–150 band. THE METER: "the cat dreams of liberty." — shown as "the stray
// dreams of peace.": CAT behind STRAY (80), already found by the bot; the secret is LIBERTY
// behind PEACE (107), and the OBVIOUS guess, FREEDOM, is its closest word (rank 1): typing it
// earns a 1, never the solve — and typing LIBERTY first swaps the two (liberty reads 1,
// freedom becomes the secret), so the activation is always seen before the solve. The bot's
// FIVE tries (few, and the best one an EASY SYNONYM, user-decided 2026-09-16) — re-picked on
// the new map (#317), where the synonyms sit far (independence 56, emancipation 41) and the
// ideology words close (democracy 4, equality 11): five tries no closer than a synonym
// cannot reach the ~72 FREEDOM needs to fill the meter alone, so the best try is the EASY
// word a player types next to liberty, EQUALITY (11): independence, equality, happiness,
// justice, dignity leave the meter at three quarters, FREEDOM fills it — visibly — and the
// given words land; a failed try then earns the hint, never the word.
//
// scripts.test.ts replays this file and fails if an edit breaks the lesson's shape.
import type { LessonScript } from '../script';
import { hole, single } from './board';
import ocean from './en.ocean.json';
import mountain from './en.mountain.json';
import dog from './en.dog.json';
import moon from './en.moon.json';
import cat from './en.cat.json';
import liberty from './en.liberty.json';

const script: LessonScript = {
  stages: [
    { kind: 'reveal', puzzle: single('en', ocean, 'sea'), hints: ['tutHintOcean'] },
    { kind: 'word', puzzle: single('en', mountain, 'ski'), hints: ['tutHintMountain'] },
    {
      kind: 'sentence',
      puzzle: {
        lang: 'en',
        revision: 'lesson',
        words: ['a', 'dog', 'barks', 'at', 'the', 'moon.'],
        holes: [hole(dog, 1, 'coyote'), hole(moon, 5, 'star', '.')],
        ranks: { [dog.word.slug]: dog.ranks, [moon.word.slug]: moon.ranks },
      },
      hints: ['tutHintDog', 'tutHintMoon'],
    },
    {
      kind: 'meter',
      puzzle: {
        lang: 'en',
        revision: 'lesson',
        words: ['the', 'cat', 'dreams', 'of', 'liberty.'],
        holes: [hole(cat, 1, 'stray'), hole(liberty, 4, 'peace', '.')],
        ranks: { [cat.word.slug]: cat.ranks, [liberty.word.slug]: liberty.ranks },
      },
      // The bot's game so far: it found the cat, then circled liberty without landing.
      played: ['cat', 'independence', 'equality', 'happiness', 'justice', 'dignity'],
      pair: { alt: { word: 'freedom', slug: 'freedom' }, hint: 'tutHintFreedom' },
      hints: ['tutHintCat', 'tutHintLiberty'],
    },
  ],
};

export default script;
