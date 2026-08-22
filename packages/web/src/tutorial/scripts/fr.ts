// The French onboarding script (#51, re-arced by #155; rarity ending 2026-08-11) — same
// one-board lesson arc as en.ts (see the header there). A French extra it teaches for
// free: accented display words are typed UNACCENTED, which the find step forces (the
// ladder words float accented).
//
// The board is a REAL neighborhood: `fr.word.json` is the #154 single-word artifact for
// TROPIQUES, pruned to what the tutorial needs. Regenerate it with (both from the REPO ROOT):
//
//   pnpm gen:word tropiques --lang fr --form tropiques=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/tropiques.json \
//     --out packages/web/src/tutorial/scripts/fr.word.json --top 150 --keep neige
//
// (the prune keeps the word, the top-150 groups — the committed zone — and the group of
// the `--keep` word, the lesson's deliberately-outside "far" guess). The committed map
// predates #163's `freq` (no entry carries it — fine, the ladder teaches the GRADES, not
// this board's data).
//
// TROPIQUES replaced PHARE on findings 2026-08-04 (phare is a homonym, and its
// neighborhood read as two definitions at once). The
// AGREEMENT is singular (`--form tropiques=n:s`, findings 2026-08-04: plural-agreed
// neighbors read oddly on a word board), while the word itself keeps its natural plural
// display — « tropiques » is the rank-0 display either way.
//
// The arc: the scramble ladder walks TROPIQUES out to its 12th neighbor (soleil) and on to
// its 97th (ananas — the start word, inside generation's own 50-150 start band, and
// unmistakably tropical), then three gated guesses teach distance (neige, 353: farther,
// hint stays — snow is INTUITIVELY the anti-tropics, climate-adjacent but far, on a
// READABLE scale), MISS (guitare, which the real map does not rank at all), and
// improvement (lagon, 22: closer, hint moves). The player then finds their way back to
// TROPIQUES, and the ending states the game's other core concept — word RARITY, the
// five-grade ladder — before JOUER ends the lesson.
import type { WordPuzzle } from '@whippin/shared';
import type { TutorialScript } from '../script';
import artifact from './fr.word.json';

const { lang, word, ranks }: WordPuzzle = artifact;

// Le départ. Sa forme affichée et son rang sont LUS dans la carte plutôt que redits ici :
// le plateau ne peut donc pas contredire son propre voisinage.
const START = 'ananas';

const script: TutorialScript = {
  puzzle: {
    lang,
    // A LESSON's board, never a published daily: it is not served, not synced and never
    // scored, so its version is a constant rather than a publish stamp (#203).
    revision: 'tutorial',
    words: [word.word],
    holes: [
      {
        pos: 0,
        secret: word,
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
        { rank: 12, labelKey: 'tutMixAgain', copyKey: 'tutMixed10' },
        { rank: ranks[START].rank, labelKey: 'tutMixMore' },
      ],
    },
    // Le feedback enseigne ; chaque essai enchaîne sur l'instruction suivante.
    { kind: 'guess', expect: 'neige', copyKey: 'tutGuessFar' },
    { kind: 'guess', expect: 'guitare', copyKey: 'tutGuessMiss' },
    { kind: 'guess', expect: 'lagon', copyKey: 'tutGuessCloser' },
    { kind: 'find', target: word.slug, copyKey: 'tutFind', nudgeKey: 'tutFindNudge' },
    // La fin : le second concept du jeu — chaque mot a une RARETÉ, dite sur l'échelle des
    // cinq grades — puis JOUER.
    { kind: 'rarity', introCopyKey: 'tutRarityIntro', ladderCopyKey: 'tutRarity' },
  ],
};

export default script;
