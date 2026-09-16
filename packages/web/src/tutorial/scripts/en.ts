// The English level-1 script (#269). Edit THIS file (and the tut* copy in i18n.ts) to
// change the lesson — the components read everything from here.
//
// The boards are REAL neighborhoods, #154 single-word artifacts pruned to their top-150
// groups. Regenerate them with (from the REPO ROOT):
//
//   pnpm gen:word ocean --lang en
//   pnpm gen:word dog --lang en
//   pnpm gen:word moon --lang en
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.ocean.json --top 150
//   (and the same for dog and moon)
//
// THE WORD: OCEAN, started at ATLANTIC (rank 3). THE FIRST TRY MUST BE VERY EASY
// (user-decided 2026-09-16): the start word practically names the answer, and sea / waters
// still move the hole for whoever goes there first.
// THE SENTENCE: "a dog barks at the moon." — DOG started at COYOTE (55) and MOON at STARS
// (62), both inside generation's own 50–150 start band, both intuitive neighbors.
//
// scripts.test.ts replays this file and fails if an edit breaks the lesson's shape.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import ocean from './en.ocean.json';
import dog from './en.dog.json';
import moon from './en.moon.json';

// A hole at its start word, both READ OFF the map rather than restated here, so the board can
// never disagree with its own neighborhood.
function hole(artifact: WordPuzzle, pos: number, start: string, suffix?: string) {
  const entry = artifact.ranks[start];
  return {
    pos,
    secret: artifact.word,
    start: { word: entry.word, slug: start },
    start_rank: entry.rank,
    ...(suffix ? { suffix } : {}),
  };
}

const script: LessonScript = {
  word: {
    puzzle: {
      lang: 'en',
      // A LESSON's board, never a published daily: it is not served, not synced and never
      // scored, so its version is a constant rather than a publish stamp (#203).
      revision: 'lesson',
      words: [ocean.word.word],
      holes: [hole(ocean, 0, 'atlantic')],
      ranks: { [ocean.word.slug]: ocean.ranks },
    },
    hints: ['tutHintOcean'],
  },
  sentence: {
    puzzle: {
      lang: 'en',
      revision: 'lesson',
      words: ['a', 'dog', 'barks', 'at', 'the', 'moon.'],
      holes: [hole(dog, 1, 'coyote'), hole(moon, 5, 'stars', '.')],
      ranks: { [dog.word.slug]: dog.ranks, [moon.word.slug]: moon.ranks },
    },
    hints: ['tutHintDog', 'tutHintMoon'],
  },
};

export default script;
