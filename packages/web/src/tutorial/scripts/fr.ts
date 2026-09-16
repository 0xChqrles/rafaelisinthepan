// The French level-1 script (#269) — same two-stage lesson as en.ts (see the header there).
// A French extra it teaches for free: accented display words are typed UNACCENTED.
//
// Regenerate the boards with (from the REPO ROOT; the never-infer rule wants the agreement
// named for a French word):
//
//   pnpm gen:word tropiques --lang fr --form tropiques=n:s
//   pnpm gen:word chien --lang fr --form chien=n:s
//   pnpm gen:word lune --lang fr --form lune=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/tropiques.json \
//     --out packages/web/src/tutorial/scripts/fr.tropiques.json --top 150
//   (and the same for chien and lune)
//
// LE MOT : TROPIQUES, départ SOLEIL (rang 12 — un plateau FACILE : mer, palmier, climat,
// exotique, cocotier font tous avancer le trou). L'accord est singulier (findings
// 2026-08-04 : des voisins accordés au pluriel se lisent mal sur un plateau d'un mot).
// LA PHRASE : « un chien aboie à la lune. » — CHIEN part de LOUP (52), LUNE de PÉNOMBRE
// (63), dans la bande de départ 50–150 de la génération.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import tropiques from './fr.tropiques.json';
import chien from './fr.chien.json';
import lune from './fr.lune.json';

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
      lang: 'fr',
      revision: 'lesson',
      words: [tropiques.word.word],
      holes: [hole(tropiques, 0, 'soleil')],
      ranks: { [tropiques.word.slug]: tropiques.ranks },
    },
    hints: ['tutHintTropiques'],
  },
  sentence: {
    puzzle: {
      lang: 'fr',
      revision: 'lesson',
      words: ['un', 'chien', 'aboie', 'à', 'la', 'lune.'],
      holes: [hole(chien, 1, 'loup'), hole(lune, 5, 'penombre', '.')],
      ranks: { [chien.word.slug]: chien.ranks, [lune.word.slug]: lune.ranks },
    },
    hints: ['tutHintChien', 'tutHintLune'],
  },
};

export default script;
