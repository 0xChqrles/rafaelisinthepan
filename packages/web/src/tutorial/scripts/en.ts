// The English level-1 script (#269). Edit THIS file (and the tut* copy in i18n.ts) to
// change the lesson — the components read everything from here.
//
// The boards are REAL neighborhoods, #154 single-word artifacts pruned to their top-150
// groups. Regenerate them with (from the REPO ROOT):
//
//   pnpm gen:word ocean --lang en
//   pnpm gen:word mountain --lang en
//   pnpm gen:word dog --lang en
//   pnpm gen:word moon --lang en
//   pnpm gen:word cat --lang en
//   pnpm gen:word freedom --lang en
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/en/ocean.json \
//     --out packages/web/src/tutorial/scripts/en.ocean.json --top 150
//   (and the same for mountain, dog, moon, cat and freedom)
//
// THE REVEAL: OCEAN, shown, then hidden behind SEA — its closest word, rank 1 — and typed
// back. THE WORD: MOUNTAIN, never shown, behind SNOW (13): a real search, intuitive clue,
// slopes / alps / hills / peaks all move the hole. THE SENTENCE: "a dog barks at the moon."
// — DOG behind COYOTE (55) and MOON behind STARS (62), the game's own 50–150 band.
// THE METER: "the cat dreams of freedom." — CAT already found by the bot, FREEDOM behind
// REVOLUTION (132) and too abstract to read off the sentence; the bot's tries (peace,
// justice, hope, happiness, truth, speech, unity, religion) leave its meter at ~99 with SPEECH
// (24) as the best word, so the player's first close guess fills it and the F lands.
//
// scripts.test.ts replays this file and fails if an edit breaks the lesson's shape.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import ocean from './en.ocean.json';
import mountain from './en.mountain.json';
import dog from './en.dog.json';
import moon from './en.moon.json';
import cat from './en.cat.json';
import freedom from './en.freedom.json';

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

// A LESSON's boards, never a published daily: not served, not synced, never scored, so the
// version is a constant rather than a publish stamp (#203).
function single(artifact: WordPuzzle, start: string) {
  return {
    lang: 'en',
    revision: 'lesson',
    words: [artifact.word.word],
    holes: [hole(artifact, 0, start)],
    ranks: { [artifact.word.slug]: artifact.ranks },
  };
}

const script: LessonScript = {
  stages: [
    { kind: 'reveal', puzzle: single(ocean, 'sea'), hints: ['tutHintOcean'] },
    { kind: 'word', puzzle: single(mountain, 'snow'), hints: ['tutHintMountain'] },
    {
      kind: 'sentence',
      puzzle: {
        lang: 'en',
        revision: 'lesson',
        words: ['a', 'dog', 'barks', 'at', 'the', 'moon.'],
        holes: [hole(dog, 1, 'coyote'), hole(moon, 5, 'stars', '.')],
        ranks: { [dog.word.slug]: dog.ranks, [moon.word.slug]: moon.ranks },
      },
      hints: ['tutHintDog', 'tutHintMoon'],
    },
    {
      kind: 'meter',
      puzzle: {
        lang: 'en',
        revision: 'lesson',
        words: ['the', 'cat', 'dreams', 'of', 'freedom.'],
        holes: [hole(cat, 1, 'whiskers'), hole(freedom, 4, 'revolution', '.')],
        ranks: { [cat.word.slug]: cat.ranks, [freedom.word.slug]: freedom.ranks },
      },
      // The bot's game so far: it found the cat, then circled freedom without landing.
      played: ['cat', 'peace', 'justice', 'hope', 'happiness', 'truth', 'speech', 'unity', 'religion'],
      hints: ['tutHintCat', 'tutHintFreedom'],
    },
  ],
};

export default script;
