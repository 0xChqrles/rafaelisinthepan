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
  // ---- Word mode (#156, retimed by #163): the second daily — name the day's word's
  // neighborhood against a countdown. Its score unit is likewise NAMED (higher is better
  // here, and "WORDS" says what was counted).
  word: { en: 'WORD', fr: 'MOT' },
  words: { en: 'WORDS', fr: 'MOTS' },
  // The final score names the achievement, not just the unit. Kept separate because the
  // live header counter and the plain-text share result still use the compact unit above.
  foundWord: { en: 'FOUND WORD', fr: 'MOT TROUVÉ' },
  foundWords: { en: 'FOUND WORDS', fr: 'MOTS TROUVÉS' },
  // Free-guess feedback: a group-level repeat (#104), and the day's word itself (it is
  // public — on the board already).
  wordRepeat: { en: 'already played', fr: 'déjà joué' },
  wordItself: { en: "that's the word itself", fr: "c'est le mot lui-même" },
  // The pre-run GATE (#163): the timer needs a start control anyway, and the control is
  // where the rules belong — so this screen is also where a first-time player learns the
  // game. TWO sentences, one idea each: what to do, and what buys more of it. Terse, in
  // the app's show-don't-tell register, and NEITHER of them states a number — the clock's
  // length is the HUD's to show and START_SECONDS is a tuning knob.
  wordRulesGoal: {
    en: 'Find words close to it before the clock runs out.',
    fr: 'Trouve des mots proches avant la fin du chrono.',
  },
  // "Rarer", not "rare": RARE is now the name of one specific grade on screen, so the rule
  // has to read as the general property rather than as a claim about that one grade.
  wordRulesBonus: {
    en: 'Every find adds time. Rarer words add more.',
    fr: 'Chaque mot ajoute du temps. Plus il est rare, plus il en donne.',
  },
  wordStart: { en: 'START', fr: 'DÉPART' },
  // A word run's day is FINISHED, never "solved" (decided 2026-08-08): the clock ran out,
  // which is not an achievement the way a reconstructed sentence is. Visually it is the
  // same gold as a solve; this is the distinction the reader hears.
  srWordDone: { en: 'done', fr: 'terminé' },
  // The header's Whippin mark opens the mode CHOOSER (2026-08-06, replacing the toggle
  // whose label had to name the mode a tap landed on), and the chooser's two cards name
  // the dailies themselves. The card names are display forms — the CSS uppercases them,
  // like the language cards' native names.
  ariaChangeMode: { en: 'Change game mode', fr: 'Changer de mode de jeu' },
  modeSentence: { en: 'Sentence', fr: 'Phrase' },
  modeWord: { en: 'Word', fr: 'Mot' },
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
  // the words above the line — guesses that earned no rank at all, so they have no node, no
  // lane and no distance to be read off, and nothing about them can be read off the drawing.
  // It reads MISSED in BOTH languages (decided 2026-08-05, superseding OFF THE MAP / HORS
  // CARTE): these words are exactly the ones the round answered with the floating `MISS`,
  // which is itself untranslated everywhere it appears (the tutorial's fr copy says MISS
  // too), so the shelf now names them in the vocabulary the player already met rather than
  // describing where they sit. Untranslated like `you` and `dnf` for the same reason — one
  // label, identical in every language.
  routeOffMap: { en: 'MISSED', fr: 'MISSED' },
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
  // (~60 chars incl. exponents at the mobile width), it is too much: cut it — or split
  // it into two beats, which is what the ending's claim and its instruction became.
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
    fr: '[[w:soleil^12]] est le 12e mot le plus proche de [[b:tropiques]].',
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
    fr: '[[m:guitare]] était trop loin — [[m:MISS]]. Essaie [[w:lagon^22]].',
  },
  tutFind: {
    en: 'Now, find the original word.',
    fr: 'Maintenant, retrouve le mot du début.',
  },
  tutFindNudge: {
    en: 'Forgot it? It was [[b:ocean]].',
    fr: "Oublié ? C'était [[b:tropiques]].",
  },
  // ---- the ending (#155): tapping the found word replaces it with its THEMES — the map's
  // roads, shown ONE AT A TIME as clouds of words, closing on the routes teaser (findings
  // 2026-08-04) — and PLAY ends the tutorial. The nudge speaks the input device's own verb —
  // tutTap on a coarse pointer, tutClick otherwise (the tapAnywhere/clickAnywhere pattern). The ending
  // opens on TWO beats, one idea each (findings 2026-08-04, splitting what had been one
  // over-long line): the CLAIM, advanced with the tray's NEXT; then the GESTURE, which is
  // where the word starts waving and becomes tappable. Each cloud is then headed
  // « Thème n/N : <name> » (built by themeHeading below, so the count comes from the board's
  // real road count and no string has to restate it), and the close says what the themes ARE.
  // tutTheme1..4 hold only the NAME — the en strings name OCEAN's themes, the fr strings
  // TROPIQUES's, since each language plays its own board.
  tutThemesIntro: {
    en: 'Several themes can live inside the same word.',
    fr: 'Plusieurs thèmes peuvent exister à travers le même mot.',
  },
  tutTap: {
    en: 'You can tap a word to discover its themes.',
    fr: 'Tu peux toucher un mot pour découvrir ses thèmes.',
  },
  tutClick: {
    en: 'You can click a word to discover its themes.',
    fr: 'Tu peux cliquer sur un mot pour découvrir ses thèmes.',
  },
  tutTheme1: { en: 'the coast', fr: 'le climat' },
  // en theme 2's cloud reads coral, arctic, waves, antarctica, surface, currents, earth,
  // tropical… — the ocean at planet scale ("the deep" mislabelled it: half the cloud is
  // surface and poles).
  tutTheme2: { en: 'the planet', fr: 'les îles' },
  tutTheme3: { en: 'seafaring', fr: 'le globe' },
  // The en string is UNREFERENCED — ocean's board ships three themes — but the parity
  // contract wants both languages; re-author it if an en board ever ships four.
  tutTheme4: { en: 'the fourth', fr: 'les vacances' },
  // Drives both opening beats and the theme stepper — one label for "go on".
  tutNext: { en: 'NEXT', fr: 'SUIVANT' },
  tutThemes: {
    en: 'Each theme is a different semantic path to follow.',
    fr: 'Chaque thème est un chemin sémantique différent à suivre.',
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
// A theme cloud's heading (#155): « Thème 2/4 : les îles ». The COUNT comes from the board's
// real road count rather than from a string, so a regenerated board with a different fork
// cannot leave the copy claiming a total it does not ship. The name wears the cloud's colour
// via CoachText's [[t:]] tag.
export function themeHeading(lang: string, n: number, total: number, name: string): string {
  return uiLang(lang) === 'fr'
    ? `Thème ${n}/${total} : [[t:${name}]]`
    : `Theme ${n}/${total}: [[t:${name}]]`;
}

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

// The shelf in words. The visible heading is the universal MISSED token, but this is PROSE
// and prose stays in the reader's language (the rule every sr helper here follows) — it
// just says the same thing the heading now does.
export function srRouteOffMap(lang: string, words: string[]): string {
  const list = words.join(', ');
  return uiLang(lang) === 'fr' ? `manqués : ${list}` : `missed: ${list}`;
}

// ---- Word mode (#156). The board drawing is decorative like the route map's; these
// carry it — and the per-guess outcomes — in words.
export function srWordBoardWord(lang: string, word: string): string {
  return uiLang(lang) === 'fr' ? `mot du jour : ${word}` : `word of the day: ${word}`;
}

// A CLAIM: what it was, its RARITY GRADE, the running count, and the seconds it bought.
// The grade replaces the rank the exponent used to carry (#163) — the same thing the
// sighted player reads off the word — and the grade names stay untranslated, exactly as
// they are on screen.
export function srWordClaim(
  lang: string,
  word: string,
  rarity: string,
  total: number,
  gained: number,
): string {
  if (uiLang(lang) === 'fr') {
    return `${word} trouvé — ${rarity}, ${total} mots, +${gained} s`;
  }
  return `claimed ${word} — ${rarity}, ${total} words, +${gained}s`;
}

// A guess that claimed nothing, whether it was ranked just outside the zone or nowhere on
// the map at all: the run cannot use it either way, and it costs only the seconds spent
// typing it. The spoken twin of the MISS the word floats — the exact distance of an
// unclaimable word is a number a player racing a clock can do nothing with, and it is kept
// where it still teaches, on the post-mortem's trunk.
export function srWordMiss(lang: string): string {
  return uiLang(lang) === 'fr' ? 'raté' : 'miss';
}


// The clock, read on demand rather than announced: `role="timer"` is a live region that
// defaults to OFF, which is the whole point — a number changing every second must never
// be spoken every second.
export function srWordClock(lang: string, seconds: number): string {
  if (uiLang(lang) === 'fr') return `${seconds} secondes restantes`;
  return `${seconds} seconds left`;
}

// The run's end, announced once when the clock reaches zero.
export function srWordTimeUp(lang: string, total: number): string {
  if (uiLang(lang) === 'fr') return `temps écoulé — ${total} mots`;
  return `time up — ${total} words`;
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
