// The French onboarding script (#51, re-arced by #155) — same one-board lesson arc as en.ts
// (see the header there). French extras it teaches for free: accented display words are typed
// UNACCENTED (désert -> desert), which the far guess and the find step both force.
//
// The board is a REAL neighborhood: `fr.word.json` is the #154 single-word artifact for
// PHARE, pruned to what the tutorial needs. Regenerate it with:
//
//   pnpm gen:word phare --lang fr --form phare=n:s
//   node scripts/prune-word-map.mjs \
//     --in ../generation/output/single-word/fr/phare.json \
//     --out src/tutorial/scripts/fr.word.json --keep desert
//
// PHARE is the near-ideal first example of ROUTES (#155): its neighborhood splits into three
// legible senses — the figurative landmark (emblématique, pilier, symbole, bastion), the car
// headlight (fanal, anti-brouillard, clignotant, lampadaire) and the maritime tower
// (sémaphore, brise-lame, bateau-feu, vigie) — so the map's lanes say something a player can
// name without being told.
//
// The arc: the scramble ladder walks PHARE out to its 100th neighbor (faisceau — the start
// word, inside generation's own 50-150 start band), then three gated guesses teach distance
// (désert, 1183: farther, hint stays), MISS (guitare, which the real map does not rank at
// all), and improvement (voilier, 51: closer, hint moves). The player then finds their way
// back to PHARE, and taps the word they found to meet the route map.
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
        { rank: 10, labelKey: 'tutMixAgain', copyKey: 'tutMixed10' },
        { rank: ranks[START].rank, labelKey: 'tutMixMore' },
      ],
    },
    // Le feedback enseigne ; chaque essai enchaîne sur l'instruction suivante.
    { kind: 'guess', expect: 'desert', copyKey: 'tutGuessFar' },
    { kind: 'guess', expect: 'guitare', copyKey: 'tutGuessMiss' },
    { kind: 'guess', expect: 'voilier', copyKey: 'tutGuessCloser' },
    { kind: 'find', target: word.slug, copyKey: 'tutFind', nudgeKey: 'tutFindNudge' },
    // La fin : toucher le mot trouvé, lire les routes, fermer — le tutoriel est terminé.
    { kind: 'tap', copyKey: 'tutTap', routeCopyKey: 'tutRoutes' },
  ],
};

export default script;
