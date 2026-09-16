// The French level-1 script (#269) — same two-stage lesson as en.ts (see the header there).
// A French extra it teaches for free: accented display words are typed UNACCENTED.
//
// Regenerate the boards with (from the REPO ROOT; the never-infer rule wants the agreement
// named for a French word):
//
//   pnpm gen:word océan --lang fr --form océan=n:s
//   pnpm gen:word chien --lang fr --form chien=n:s
//   pnpm gen:word lune --lang fr --form lune=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/ocean.json \
//     --out packages/web/src/tutorial/scripts/fr.ocean.json --top 150
//   (and the same for chien and lune)
//
// LE MOT : OCÉAN, indice MER — LE MOT LE PLUS PROCHE, rang 1 (décision utilisateur
// 2026-09-16, quatrième passe, après TROPIQUES, ÎLE, PLAGE puis ATLANTIQUE : « playing with a
// -1 synonym at first would be easier »). L'indice étant un synonyme, le coach le dit en
// mots simples — « mer est le mot le plus proche du mot secret » — sans ordinal à saisir, et
// la première victoire est à un essai. Un mauvais essai gagne un nombre plus grand à côté du
// 1 : c'est là que « plus loin = plus grand » s'apprend, par le mot du joueur.
// LA PHRASE : « un chien aboie à la lune. » — CHIEN part de LOUP (52), LUNE de PÉNOMBRE
// (63), dans la bande de départ 50–150 de la génération.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import ocean from './fr.ocean.json';
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
      words: [ocean.word.word],
      holes: [hole(ocean, 0, 'mer')],
      ranks: { [ocean.word.slug]: ocean.ranks },
    },
    hints: ['tutHintOcean'],
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
