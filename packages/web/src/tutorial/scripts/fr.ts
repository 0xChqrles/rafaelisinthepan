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
//   pnpm gen:word sentier --lang fr --form sentier=n:s
//   node packages/web/scripts/prune-word-map.mjs \
//     --in packages/generation/output/single-word/fr/ocean.json \
//     --out packages/web/src/tutorial/scripts/fr.ocean.json --top 150
//   (et de même pour montagne, chien, lune, chat et sentier)
//
// LA RÉVÉLATION : OCÉAN, montré, puis caché derrière MER — son mot le plus proche, rang 1 —
// et retapé. LE MOT : MONTAGNE, jamais montré, derrière SKI (14) : une vraie recherche,
// indice intuitif, colline / vallée / cime font tous avancer le trou. LA PHRASE : « un chien
// aboie à la lune. » — CHIEN derrière LOUP (52), LUNE derrière PÉNOMBRE (63), dans la bande
// de départ 50–150 de la génération. LA JAUGE : « le chat suit le sentier. » — CHAT déjà trouvé
// par le bot ; le secret est SENTIER et l'essai ÉVIDENT, CHEMIN, est son mot le plus proche
// (rang 1) : le taper vaut un 1, jamais la solution — et taper SENTIER en premier échange les
// deux (sentier lit 1, chemin devient le secret), pour que la lettre soit toujours vue avant
// la solution. Les essais du bot (randonneur, village,
// rocher, circuit, refuge, versant, pont — masculins, pour que « le » tienne) laissent la
// jauge à ~74 avec RANDONNEUR (29) pour meilleur mot — un mot LONG, pour que le remplissage
// se lise sur la puce (« col » était trop court, retour utilisateur 2026-09-16) : CHEMIN la
// remplit, visiblement, et le S apparaît ; le bot pose ensuite sentier lui-même.
import type { WordPuzzle } from '@whippin/shared';
import type { LessonScript } from '../script';
import ocean from './fr.ocean.json';
import montagne from './fr.montagne.json';
import chien from './fr.chien.json';
import lune from './fr.lune.json';
import chat from './fr.chat.json';
import sentier from './fr.sentier.json';

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
        words: ['le', 'chat', 'suit', 'le', 'sentier.'],
        holes: [hole(chat, 1, 'museau'), hole(sentier, 4, 'falaise', '.')],
        ranks: { [chat.word.slug]: chat.ranks, [sentier.word.slug]: sentier.ranks },
      },
      // La partie du bot jusqu'ici : le chat trouvé, puis le sentier tourné autour sans tomber.
      played: ['chat', 'randonneur', 'village', 'rocher', 'circuit', 'refuge', 'versant', 'pont'],
      pair: { alt: { word: 'chemin', slug: 'chemin' } },
      hints: ['tutHintChat', 'tutHintSentier'],
    },
  ],
};

export default script;
