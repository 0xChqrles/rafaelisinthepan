// UI chrome strings, localized per game language. The puzzle CONTENT was always
// localized (words, accents); this covers the chrome around it — status screens,
// buttons, feedback, aria labels — so a /fr player is not addressed in English.
//
// Scope: exactly two UI languages, mirroring the two game languages. Every key holds
// BOTH translations and the `satisfies` clause makes a missing one a type error, so
// parity is enforced at compile time (no runtime fallback path to test). Game screens
// resolve strings with the PUZZLE's language; the language selector (which has no
// puzzle) uses the resolved home language (last played, else browser).

type UiLang = 'en' | 'fr';

const uiLang = (lang: string): UiLang => (lang === 'fr' ? 'fr' : 'en');

const STRINGS = {
  loading: { en: 'LOADING…', fr: 'CHARGEMENT…' },
  failedPuzzle: { en: 'FAILED TO LOAD PUZZLE', fr: 'ÉCHEC DU CHARGEMENT DU PUZZLE' },
  failedVocab: { en: 'FAILED TO LOAD VOCABULARY', fr: 'ÉCHEC DU CHARGEMENT DU DICTIONNAIRE' },
  retry: { en: 'RETRY', fr: 'RÉESSAYER' },
  // The missing-puzzle state is ABNORMAL (a publish that did not happen), and the
  // wording says so — it must not read like a scheduled day off.
  noPuzzle: { en: "TODAY'S PUZZLE IS MISSING", fr: 'LE PUZZLE DU JOUR EST INTROUVABLE' },
  noPuzzleNote: {
    en: 'This is not supposed to happen — check back in a moment.',
    fr: "Ce n'est pas normal — revenez d'ici quelques instants.",
  },
  // Since the archive (#55) that same screen also renders on a DATED route, where the
  // wording above is wrong twice over: it isn't today, and a past day that was never
  // published (a pre-launch date, a language backfilled later) is perfectly normal —
  // nothing to apologize for and nothing to come back for. The dated variant states the
  // fact and points back at the calendar the player came from.
  noPuzzleDay: { en: 'NO PUZZLE FOR THIS DAY', fr: 'PAS DE PUZZLE POUR CE JOUR' },
  noPuzzleDayNote: {
    en: 'This day was never published.',
    fr: "Ce jour n'a jamais été publié.",
  },
  backToArchive: { en: 'BACK TO ARCHIVE', fr: "RETOUR À L'ARCHIVE" },
  changeLanguage: { en: 'CHANGE LANGUAGE', fr: 'CHANGER DE LANGUE' },
  srLangSolved: { en: 'solved', fr: 'résolu' },
  notAWord: { en: 'this word does not exist', fr: "ce mot n'existe pas" },
  // The score unit stays NAMED in both languages (lower is better must survive the
  // share card); the share text lowercases these.
  try: { en: 'TRY', fr: 'ESSAI' },
  tries: { en: 'TRIES', fr: 'ESSAIS' },
  // Deliberately NOT translated (decided 2026-07-24): "YOU" is universal enough, and one
  // label keeps the player's tag identical across languages (lineup + leaderboard).
  you: { en: 'YOU', fr: 'YOU' },
  dnf: { en: 'DNF', fr: 'DNF' },
  share: { en: 'SHARE', fr: 'PARTAGER' },
  copied: { en: 'COPIED', fr: 'COPIÉ' },
  // Solved tray → the full leaderboard dialog (decided 2026-07-25).
  seeMore: { en: 'SEE MORE', fr: 'VOIR PLUS' },
  // That dialog's NAME, in its shared modal header and as its aria-label (2026-07-27). The
  // button that opens it says SEE MORE, which names an action, not the surface it lands on.
  leaderboard: { en: 'LEADERBOARD', fr: 'CLASSEMENT' },
  ariaClose: { en: 'close', fr: 'fermer' },
  // ---- route modal (#117): a hole's neighborhood drawn as a LINE you travel. The line
  // teaches by SHAPE — the terminus, "you are here", the departure and the roads are all
  // said by a node's size, colour and lane — so it carries no labels at all (the tags
  // ARRIVAL / YOU ARE HERE / START / ROADS were removed 2026-07-26). The screen-reader
  // mirror still names every one of them: see `srRouteStop` below, which spells them out
  // in prose rather than depending on any of this. The ONE string left is the heading over
  // the words above the torn break — guesses that earned no rank at all, so they have no
  // node, no lane and no distance to be read off.
  routeOffMap: { en: 'OFF THE MAP', fr: 'HORS CARTE' },
  // The streak celebration's ending hint: pure "what to do" — the whole screen dismisses,
  // so naming a "why" (continue/close — continue to WHAT? the game is done) would only
  // raise a question it can't answer. Pointer-aware: coarse pointers read TAP.
  tapAnywhere: { en: 'TAP ANYWHERE', fr: "TOUCHEZ L'ÉCRAN" },
  clickAnywhere: { en: 'CLICK ANYWHERE', fr: "CLIQUEZ N'IMPORTE OÙ" },
  // Streak labels (#56/#74). Untranslated in French too — a global game concept across
  // languages (decided 2026-07-09). `streak` names the compact header stat to screen readers;
  // `dayStreak` is the celebration-dialog label under the number ("3 / DAY STREAK").
  streak: { en: 'STREAK', fr: 'STREAK' },
  dayStreak: { en: 'DAY STREAK', fr: 'DAY STREAK' },
  srSolvedAll: { en: 'sentence solved!', fr: 'phrase résolue !' },
  ariaChangeLanguage: { en: 'Change language', fr: 'Changer de langue' },
  ariaKeyboard: { en: 'on-screen keyboard', fr: 'clavier virtuel' },
  ariaEnter: { en: 'enter', fr: 'entrée' },
  ariaBackspace: { en: 'backspace', fr: 'effacer' },
  ariaDash: { en: 'dash', fr: 'tiret' },
  ariaHelp: { en: 'How to play', fr: 'Comment jouer' },
  ariaSkipTutorial: { en: 'Skip tutorial', fr: 'Passer le tutoriel' },
  // ---- archive calendar (#55): playable past days behind a calendar screen.
  archive: { en: 'ARCHIVE', fr: 'ARCHIVE' },
  ariaArchive: { en: 'Past puzzles', fr: 'Puzzles précédents' },
  ariaBackToToday: { en: "Back to today's puzzle", fr: 'Retour au puzzle du jour' },
  ariaPrevMonth: { en: 'Previous month', fr: 'Mois précédent' },
  ariaNextMonth: { en: 'Next month', fr: 'Mois suivant' },
  // ---- tutorial invitation (#51): the tutorial never starts without an action.
  inviteTitle: {
    en: 'First time playing?',
    fr: 'Première partie ?',
  },
  inviteText: {
    en: 'Learn how to play in 30 seconds.',
    fr: 'Apprends à jouer en 30 secondes.',
  },
  inviteTutorial: { en: 'TUTORIAL', fr: 'TUTORIEL' },
  inviteSkip: { en: 'SKIP', fr: 'PASSER' },
  // ---- onboarding tutorial (#51). In guess-step copy, {WORD} is replaced by the
  // script's expected word (uppercased) so the copy can never drift from the script.
  // Tutorial copy is deliberately TERSE: the feedback on screen does the teaching,
  // the top box only sets up the next move. No under-the-hood talk. HARD LIMIT: the
  // coach box is exactly 3 lines and clips — if a string wraps past three lines
  // (~70 chars incl. exponents at the mobile width), it is too much: cut it.
  // Copy uses CoachText's inline markup so words LOOK like what they are in-game:
  // [[b:secret]] blue, [[w:hint^rank]] gold + heat exponent, [[m:miss]] coldest heat.
  tutMixIntro: {
    en: 'Welcome to Whippin AI, please start by mixing this word.',
    fr: 'Bienvenue sur Whippin AI, commence par mélanger ce mot.',
  },
  tutMix: { en: 'MIX', fr: 'MÉLANGER' },
  tutMixAgain: { en: 'MIX AGAIN', fr: 'MÉLANGE ENCORE' },
  tutMixMore: { en: 'MIX EVEN MORE', fr: 'ENCORE PLUS' },
  tutMixed1: {
    en: '[[w:sea^1]] is the closest word to [[b:ocean]].',
    fr: '[[w:tropicales^1]] est le mot le plus proche de [[b:tropiques]].',
  },
  tutMixed10: {
    en: '[[w:islands^10]] is the 10th closest word to [[b:ocean]].',
    fr: '[[w:soleils^12]] est le 12e mot le plus proche de [[b:tropiques]].',
  },
  tutGuessFar: {
    en: 'Now type [[w:forest^214]].',
    fr: 'Maintenant tape [[w:neige^353]].',
  },
  tutGuessMiss: {
    en: 'Type a completely different word: [[m:violin]].',
    fr: 'Tape un mot complètement différent : [[m:guitare]].',
  },
  tutGuessCloser: {
    en: '[[m:violin]] was a [[m:MISS]] — too far to rank. Now try [[w:boat^45]].',
    fr: '[[m:guitare]] était trop loin — [[m:MISS]]. Essaie [[w:lagons^22]].',
  },
  tutFind: {
    en: 'Now type the very first word — the blue one.',
    fr: 'Maintenant, tape le tout premier mot — celui en bleu.',
  },
  tutFindNudge: {
    en: 'Forgot it? It was [[b:ocean]].',
    fr: "Oublié ? C'était [[b:tropiques]].",
  },
  // ---- the ending (#155): tapping the found word replaces it with its route line, and
  // PLAY ends the tutorial. The nudge speaks the input device's own verb — tutTap on a
  // coarse pointer, tutClick otherwise (the tapAnywhere/clickAnywhere pattern). The roads
  // are then shown ONE AT A TIME (findings 2026-08-04): tutRoad1..4 each name the road on
  // screen alone — the en strings name OCEAN's themes, the fr strings TROPIQUES's, since
  // each language plays its own board — and tutRoutes closes on the general principle once
  // every road has spoken. Plain words, no under-the-hood talk.
  tutTap: {
    en: 'Found it. Now tap [[b:ocean]].',
    fr: 'Trouvé. Touche [[b:tropiques]].',
  },
  tutClick: {
    en: 'Found it. Now click [[b:ocean]].',
    fr: 'Trouvé. Clique sur [[b:tropiques]].',
  },
  tutRoad1: {
    en: 'Each road is a theme. The first: the coast.',
    fr: 'Chaque route est un thème. La première : le climat.',
  },
  tutRoad2: {
    en: 'The second: the deep.',
    fr: 'La deuxième : les îles.',
  },
  tutRoad3: {
    en: 'The third: seafaring.',
    fr: 'La troisième : le globe.',
  },
  // The en string is UNREFERENCED — ocean's board ships three roads — but the parity
  // contract wants both languages; re-author it if an en board ever ships four.
  tutRoad4: {
    en: 'The fourth road.',
    fr: 'La quatrième : les vacances.',
  },
  tutNextRoad: { en: 'NEXT ROAD', fr: 'ROUTE SUIVANTE' },
  tutRoutes: {
    en: 'Every word has its own roads.',
    fr: 'Chaque mot a ses routes.',
  },
  tutPlay: { en: 'PLAY', fr: 'JOUER' },
} satisfies Record<string, Record<UiLang, string>>;

export type UiKey = keyof typeof STRINGS;

export function t(lang: string, key: UiKey): string {
  return STRINGS[key][uiLang(lang)];
}

// Screen-reader feedback for one hole's reaction to a guess (the visual equivalent is
// the floating distance number / "MISS"). `rank` is the guess's rank for that hole,
// or null when it is too far (not in the top-K map). Holes are numbered 1-based in
// sentence order.
export function srHoleResult(lang: string, n: number, rank: number | null): string {
  if (uiLang(lang) === 'fr') {
    if (rank == null) return `mot ${n} : raté`;
    if (rank === 0) return `mot ${n} : trouvé !`;
    return `mot ${n} : à ${rank}`;
  }
  if (rank == null) return `word ${n}: miss`;
  if (rank === 0) return `word ${n}: solved!`;
  return `word ${n}: ${rank} away`;
}

// ---- route modal (#117). Holes are numbered like the run ruler's ticks and the share
// row's keycaps: 1-based over the sentence's DISTINCT secrets, so two occurrences of one
// secret — which share a rank map, and so share a map — carry the same number.
export function routeTitle(lang: string, n: number): string {
  return uiLang(lang) === 'fr' ? `MOT ${n}` : `WORD ${n}`;
}

export function ariaExploreHole(lang: string, n: number): string {
  return uiLang(lang) === 'fr' ? `Explorer le mot ${n}` : `Explore word ${n}`;
}

// The route drawing is decorative (aria-hidden); these carry it in words. Closest first,
// misses last — the same order the map reads top to bottom.
export function srRouteDestination(lang: string, word: string | null): string {
  if (uiLang(lang) === 'fr') return `destination : ${word ?? 'cachée'}`;
  return `destination: ${word ?? 'hidden'}`;
}

export function srRouteStop(
  lang: string,
  stop: { rank: number; word: string | null; road: string | null; start?: boolean; best?: boolean },
): string {
  const fr = uiLang(lang) === 'fr';
  const parts = [fr ? `rang ${stop.rank}` : `rank ${stop.rank}`];
  parts.push(stop.word ?? (fr ? 'caché' : 'hidden'));
  // A lane titled by the very word being announced would only repeat it.
  if (stop.road && stop.road !== stop.word) parts.push(fr ? `route ${stop.road}` : `road ${stop.road}`);
  if (stop.start) parts.push(fr ? 'départ' : 'start');
  if (stop.best) parts.push(fr ? 'vous êtes ici' : 'you are here');
  return parts.join(' — ');
}

// The censored near field is now the bulk of the drawing — 150-odd stations whose only content is
// a position and a lane (#117, 2026-07-26). Announcing them one at a time would bury the words the
// player actually knows under a list of "rank 87, hidden", so the sr mirror states them as a
// COUNT: what they say collectively is how long and how populated each road is, which is exactly
// the thing the full roads were drawn to show.
export function srRouteRoads(lang: string, perRoad: number[], found: number): string {
  const total = perRoad.reduce((n, count) => n + count, 0);
  const split = perRoad.join(' / ');
  if (uiLang(lang) === 'fr') {
    return perRoad.length > 1
      ? `voisinage : ${total} arrêts sur ${perRoad.length} routes (${split}), ${found} trouvés`
      : `voisinage : ${total} arrêts, ${found} trouvés`;
  }
  return perRoad.length > 1
    ? `neighborhood: ${total} stops across ${perRoad.length} roads (${split}), ${found} found`
    : `neighborhood: ${total} stops, ${found} found`;
}

export function srRouteOffMap(lang: string, words: string[]): string {
  const list = words.join(', ');
  return uiLang(lang) === 'fr' ? `hors carte : ${list}` : `off the map: ${list}`;
}

// Screen-reader mirror of the standings lineup's meaningful events (#81) — the visual
// lineup is decorative. Full model labels, never the compact tags. `srModelLead` is the
// lead loss (the best model catches the player); `srModelAhead` a later pass.
export function srModelLead(lang: string, label: string, tries: number): string {
  if (uiLang(lang) === 'fr') return `${label} prend la tête à ${tries}`;
  return `${label} takes the lead at ${tries}`;
}

export function srModelAhead(lang: string, label: string, tries: number): string {
  if (uiLang(lang) === 'fr') return `${label} devant à ${tries}`;
  return `${label} ahead at ${tries}`;
}
