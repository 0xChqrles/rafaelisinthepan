// The French onboarding script (#51, re-arced by #155) — same one-board lesson arc as en.ts
// (see the header there). A French extra it teaches for free: accented display words are
// typed UNACCENTED, which the find step forces (phare's ladder words float accented).
//
// The board is a REAL neighborhood: `fr.word.json` is the #154 single-word artifact for
// PHARE, pruned to what the tutorial needs. Regenerate it with (both from the REPO ROOT):
//
//   pnpm gen:word phare --lang fr --form phare=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/phare.json \
//     --out packages/web/src/tutorial/scripts/fr.word.json --keep casquette
//
// PHARE is the near-ideal first example of ROUTES (#155): its neighborhood splits into three
// legible senses — the figurative landmark (emblématique, pilier, symbole, bastion), the car
// headlight (fanal, anti-brouillard, clignotant, lampadaire) and the maritime tower
// (sémaphore, brise-lame, bateau-feu, vigie) — so the map's lanes say something a player can
// name without being told.
//
// The arc: the scramble ladder walks PHARE out to its 25th neighbor (lampadaire — picked over
// rank 10's figurative « pilier » because a street lamp NEAR a lighthouse is intuition, not a
// puzzle; findings 2026-08-03) and on to its 100th (faisceau — the start word, inside
// generation's own 50-150 start band), then three gated guesses teach distance (casquette,
// 330: farther, hint stays — an everyday word on a READABLE scale, replacing désert^1183,
// same findings), MISS (guitare, which the real map does not rank at all), and improvement
// (voilier, 51: closer, hint moves). The player then finds their way back to PHARE, and taps
// the word they found — its route line takes its place, and JOUER ends the lesson.
import type { WordPuzzle } from '@whippin/shared';
import type { TutorialScript } from '../script';
import artifact from './fr.word.json';

const { lang, word, ranks }: WordPuzzle = artifact;

// Le départ. Sa forme affichée et son rang sont LUS dans la carte plutôt que redits ici :
// le plateau ne peut donc pas contredire son propre voisinage.
const START = 'faisceau';

const script: TutorialScript = {
  puzzle: {
    lang,
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
        { rank: 25, labelKey: 'tutMixAgain', copyKey: 'tutMixed10' },
        { rank: ranks[START].rank, labelKey: 'tutMixMore' },
      ],
    },
    // Le feedback enseigne ; chaque essai enchaîne sur l'instruction suivante.
    { kind: 'guess', expect: 'casquette', copyKey: 'tutGuessFar' },
    { kind: 'guess', expect: 'guitare', copyKey: 'tutGuessMiss' },
    { kind: 'guess', expect: 'voilier', copyKey: 'tutGuessCloser' },
    { kind: 'find', target: word.slug, copyKey: 'tutFind', nudgeKey: 'tutFindNudge' },
    // La fin : toucher le mot trouvé — les routes prennent sa place — puis JOUER.
    { kind: 'tap', tapCopyKey: 'tutTap', clickCopyKey: 'tutClick', routeCopyKey: 'tutRoutes' },
  ],
};

export default script;
