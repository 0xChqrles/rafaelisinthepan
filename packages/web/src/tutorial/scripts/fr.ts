// The French level-1 script (#269) — same two-stage lesson as en.ts (see the header there).
// A French extra it teaches for free: accented display words are typed UNACCENTED.
//
// Regenerate the boards with (from the REPO ROOT; the never-infer rule wants the agreement
// named for a French word):
//
//   pnpm gen:word océan --lang fr --form océan=n:s
//   pnpm gen:word montagne --lang fr --form montagne=n:s
//   pnpm gen:word chien --lang fr --form chien=n:s
//   pnpm gen:word lune --lang fr --form lune=n:s
//   pnpm gen:word chat --lang fr --form chat=n:s
//   pnpm gen:word liberté --lang fr --form liberté=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/ocean.json \
//     --out packages/web/src/tutorial/scripts/fr.ocean.json --top 150
//   (et de même pour montagne, chien, lune, chat et liberté)
//
// LA RÉVÉLATION : OCÉAN, montré, puis caché derrière MER — son mot le plus proche, rang 1 —
// et retapé. LE MOT : MONTAGNE, jamais montré, derrière SKI (14) : une vraie recherche,
// indice intuitif, colline / vallée / cime font tous avancer le trou. LA PHRASE : « un chien
// aboie à la lune. » — CHIEN derrière LOUP (52), LUNE derrière PÉNOMBRE (63), dans la bande
// de départ 50–150 de la génération. LA JAUGE : « le chat rêve de liberté. » — CHAT déjà trouvé
// par le bot, LIBERTÉ derrière OPPRESSION (124) et trop abstrait pour se lire dans la
// phrase ; les essais du bot (paix, justice, égalité, vérité, parole, religion, droits)
// laissent sa jauge à ~95 avec ÉGALITÉ (23) pour meilleur mot : le premier essai proche du
// joueur la remplit et le L apparaît.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import ocean from './fr.ocean.json';
import montagne from './fr.montagne.json';
import chien from './fr.chien.json';
import lune from './fr.lune.json';
import chat from './fr.chat.json';
import liberte from './fr.liberte.json';

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

function single(artifact: WordPuzzle, start: string) {
  return {
    lang: 'fr',
    revision: 'lesson',
    words: [artifact.word.word],
    holes: [hole(artifact, 0, start)],
    ranks: { [artifact.word.slug]: artifact.ranks },
  };
}

const script: LessonScript = {
  stages: [
    { kind: 'reveal', puzzle: single(ocean, 'mer'), hints: ['tutHintOcean'] },
    { kind: 'word', puzzle: single(montagne, 'ski'), hints: ['tutHintMontagne'] },
    {
      kind: 'sentence',
      puzzle: {
        lang: 'fr',
        revision: 'lesson',
        words: ['un', 'chien', 'aboie', 'à', 'la', 'lune.'],
        holes: [hole(chien, 1, 'loup'), hole(lune, 5, 'penombre', '.')],
        ranks: { [chien.word.slug]: chien.ranks, [lune.word.slug]: lune.ranks },
      },
      hints: ['tutHintChien', 'tutHintLune'],
    },
    {
      kind: 'meter',
      puzzle: {
        lang: 'fr',
        revision: 'lesson',
        words: ['le', 'chat', 'rêve', 'de', 'liberté.'],
        holes: [hole(chat, 1, 'museau'), hole(liberte, 4, 'oppression', '.')],
        ranks: { [chat.word.slug]: chat.ranks, [liberte.word.slug]: liberte.ranks },
      },
      // La partie du bot jusqu'ici : le chat trouvé, puis liberté tournée autour sans tomber.
      played: ['chat', 'paix', 'justice', 'egalite', 'verite', 'parole', 'religion', 'droits'],
      hints: ['tutHintChat', 'tutHintLiberte'],
    },
  ],
};

export default script;
