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
  // The #188 profile read. Its failure is NOT silent like a score submission's: what
  // the server holds is the editor's whole starting point, so a guess could be saved
  // over the real profile — the reader retries instead.
  failedProfile: { en: 'FAILED TO LOAD PROFILE', fr: 'ÉCHEC DU CHARGEMENT DU PROFIL' },
  // The #189 invite link's write, loud for the same reason: it is the one thing that
  // click existed to do, so losing it silently would leave both players none the wiser.
  failedInvite: { en: 'FAILED TO ADD FRIEND', fr: "ÉCHEC DE L'AJOUT EN AMI" },
  // The one refusal a player can act on, so it is the one refusal that speaks (#189). Asking
  // again cannot change it — a full list is a state, not a hiccup — so this reads as a fact
  // and its button plays rather than retries. Neutral about WHOSE list: the cap binds either
  // side of the pair, and the clicker cannot tell which.
  friendListFull: { en: 'FRIEND LIST FULL', fr: "LISTE D'AMIS PLEINE" },
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
  // the app's show-don't-tell register.
  //
  // It states exactly ONE number, `{n}` — HOW MANY words count (user-decided 2026-08-11,
  // superseding "neither of them states a number"): "close to it" gave the player no way
  // to know what they were aiming at, where a count is a target they can hold. The clock's
  // length is still NOT stated — that one the HUD shows, and showing it here would be
  // saying twice what the timer already says once.
  //
  // The number is a PLACEHOLDER, never spelled into the copy: it is `CLAIM_ZONE`, a tuning
  // knob, and a hardcoded "1000" would quietly start lying the first time the zone moves.
  // `{n}` is the only placeholder this table uses (see `tn`), which is what keeps the line
  // in the type-checked en+fr table — parity by compiler — instead of in a hand-written
  // bilingual function like the sr helpers below.
  wordRulesGoal: {
    en: 'Find words among the {n} closest before the clock runs out.',
    fr: 'Trouve des mots parmi les {n} plus proches avant la fin du chrono.',
  },
  // "Rarer", not "rare": RARE is now the name of one specific grade on screen, so the rule
  // has to read as the general property rather than as a claim about that one grade.
  wordRulesBonus: {
    en: 'Every find adds time. Rarer words add more.',
    fr: 'Chaque mot ajoute du temps. Plus il est rare, plus il en donne.',
  },
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
  share: { en: 'SHARE', fr: 'PARTAGER' },
  copied: { en: 'COPIED', fr: 'COPIÉ' },
  // ---- the solved screen's STANDING (#170, user-decided 2026-08-15, replacing the
  // population histogram): ONE line — `RANK #6 OF 60` with a `TOP 25%` badge beside it.
  // The rank NUMBER is drawn by the component (it wears its own size and colour), so the
  // words here are only what surrounds it. `TOP` is untranslated in every language, like
  // MISS and the rarity grades — one word, identical everywhere.
  scoreRank: { en: 'RANK', fr: 'RANG' },
  scoreOf: { en: 'OF {n}', fr: 'SUR {n}' },
  scoreTop: { en: 'TOP', fr: 'TOP' },
  // Untranslated on purpose (the user's call): one word in every language, like the
  // rarity grades.
  scoreRanking: { en: 'RANKING...', fr: 'RANKING...' },
  // The solved credit block's one function word (user-decided 2026-08-15): it binds the
  // author to the work in the line under it — `Les Misérables` / `BOOK by Victor Hugo` can
  // only be read one way, where two stacked names could be read either. LOWERCASE, unlike
  // every other string here: it is the one word in this app that is not a label but part
  // of a phrase, and the KIND beside it is uppercased in code to keep that contrast. Drawn
  // only when BOTH a work and an author exist; a lone author is a name, not a credit, and
  // takes the headline itself.
  sourceBy: { en: 'by', fr: 'de' },
  ariaClose: { en: 'close', fr: 'fermer' },
  // ---- the route drawing (#117): a hole's neighborhood drawn as a LINE you travel. The
  // line teaches by SHAPE — the terminus, "you are here" and the departure are all said by
  // a node's size and colour — so it carries no labels at all (the tags ARRIVAL / YOU ARE
  // HERE / START were removed 2026-07-26). The screen-reader mirror still names every one
  // of them: see `srRouteStop` below, which spells them out in prose rather than depending
  // on any of this. The ONE string left is the heading over the words above the line —
  // guesses that earned no rank at all, so they have no node and no distance to be read
  // off, and nothing about them can be read off the drawing.
  // It reads MISSED in BOTH languages (decided 2026-08-05, superseding OFF THE MAP / HORS
  // CARTE): these words are exactly the ones the round answered with the floating `MISS`,
  // which is itself untranslated everywhere it appears (the tutorial's fr copy says MISS
  // too), so the shelf now names them in the vocabulary the player already met rather than
  // describing where they sit. Untranslated for the same reason MISS is — one label,
  // identical in every language.
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
    en: 'Learn how to play in 60 seconds.',
    fr: 'Apprends à jouer en 60 secondes.',
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
  // [[b:secret]] solve cobalt, [[w:hint^rank]] pale hole + rank exponent,
  // [[m:miss]] MISS's weird red.
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
  // ---- the ending (2026-08-11, superseding the #155 themes tap): the game's second core
  // concept, word RARITY, in two beats — the claim over the found word, then the five-grade
  // ladder (RarityLadder) under the line that says what it means. The grade names are the
  // game's own untranslated vocabulary (COMMON..ARCANE) and come from RARITY_NAMES, never
  // from a string here. What a grade PAYS is deliberately not stated — that is Word mode's
  // rule, and it lives on Word mode's own gate (wordRulesBonus).
  tutRarityIntro: {
    en: 'One last thing: every word has a rarity.',
    fr: 'Une dernière chose : chaque mot a une rareté.',
  },
  // The ladder line states the CONCEPT and nothing more: rarity is a fact about the
  // language (user-decided 2026-08-11 — "precious" was Word mode's framing, where a grade
  // pays the clock, and the tutorial teaches core principles only).
  tutRarity: {
    en: 'From everyday words to nearly forgotten ones.',
    fr: 'Des mots de tous les jours aux mots presque oubliés.',
  },
  // One OBVIOUS example word per grade (user-decided 2026-08-11): the ladder teaches by
  // evidence, so the words are picked for intuition — a very common word for COMMON down
  // to a genuinely unheard-of one for ARCANE — hand-authored per language, monotone by
  // feel rather than measured against the corpus.
  tutRarityExCommon: { en: 'house', fr: 'maison' },
  tutRarityExUncommon: { en: 'twilight', fr: 'crépuscule' },
  tutRarityExRare: { en: 'obelisk', fr: 'alambic' },
  tutRarityExObscure: { en: 'reliquary', fr: 'cénotaphe' },
  tutRarityExArcane: { en: 'apricity', fr: 'zinzolin' },
  // The rarity ladder's screen-reader line; the component appends the grade names.
  srRarityLadder: {
    en: 'Word rarities, from most common to rarest:',
    fr: 'Raretés des mots, du plus courant au plus rare :',
  },
  // Advances the ending's claim beat — one label for "go on".
  tutNext: { en: 'NEXT', fr: 'SUIVANT' },
  tutPlay: { en: 'PLAY', fr: 'JOUER' },
  // ---- the sentence game's one-time PLAY gate (2026-08-11): each mode explains ITS OWN
  // rules before the first round — Word mode's gate is mandatory (its PLAY starts the
  // clock), this one exists only for the instructions, so it is shown ONCE ever (the
  // persisted `sentenceRulesSeen` flag) and PLAY is its whole job. TWO rules, one idea
  // each — the goal and the history tap, the tap line in the input device's own verb (the
  // tapAnywhere/clickAnywhere pattern). Rendered as BULLETS in the shared rules box
  // (the tutorial's coach dialog — see `.coach-rules`).
  sentenceRulesGoal: {
    en: 'Some words were swapped out. Guess the originals.',
    fr: 'Des mots ont été remplacés. Retrouve les originaux.',
  },
  sentenceRulesHistoryTap: {
    en: 'Tap a word to see your tries on it.',
    fr: 'Touche un mot pour revoir tes essais.',
  },
  sentenceRulesHistoryClick: {
    en: 'Click a word to see your tries on it.',
    fr: 'Clique sur un mot pour revoir tes essais.',
  },
  // ONE action button for BOTH gates (word mode adopted the sentence gate's PLAY label).
  gatePlay: { en: 'PLAY', fr: 'JOUER' },
  // ---- the profile editor (#188): name + 10×10 palette avatar + the key as backup.
  // Show-don't-tell: terse labels, the surfaces demonstrate themselves.
  profileTitle: { en: 'PROFILE', fr: 'PROFIL' },
  profileNamePlaceholder: { en: 'NAME', fr: 'PSEUDO' },
  // The button's ONE label: it never renames itself — saving is said by the dot-loader
  // choreography, success by the button going quiet (disabled, LED off).
  profileSave: { en: 'SAVE', fr: 'ENREGISTRER' },
  profileSaveFailed: { en: 'SAVE FAILED', fr: "ÉCHEC DE L'ENREGISTREMENT" },
  profileNameRejected: { en: 'NAME NOT ALLOWED', fr: 'PSEUDO REFUSÉ' },
  profileAvatarRejected: { en: 'AVATAR NOT ALLOWED', fr: 'AVATAR REFUSÉ' },
  // Untranslated in every language (the user's call, 2026-08-19) — one word everywhere,
  // like MISS, TOP and the rarity grades.
  profileClear: { en: 'CLEAR', fr: 'CLEAR' },
  ariaAvatarEditor: { en: 'Avatar editor: tap to paint', fr: "Éditeur d'avatar : touchez pour peindre" },
  ariaPalette: { en: 'Palette', fr: 'Palette' },
  // ---- the leaderboard screen (#190): friends board first, global top 50 as the
  // untrusted tab. Terse chrome in the app's register; the tabs and the rows do the
  // explaining. GLOBAL is one word in both languages, like TOP and the grades.
  boardTitle: { en: 'LEADERBOARD', fr: 'CLASSEMENT' },
  boardFriends: { en: 'FRIENDS', fr: 'AMIS' },
  boardGlobal: { en: 'GLOBAL', fr: 'GLOBAL' },
  // One empty line for both tabs: no friend has a score yet / nobody played yet. The
  // INVITE button above is the remedy, so the line states the fact and nothing more.
  boardEmpty: { en: 'NO ONE ON THE BOARD YET', fr: 'ENCORE PERSONNE AU TABLEAU' },
  boardEdit: { en: 'EDIT', fr: 'MODIFIER' },
  boardInvite: { en: 'INVITE FRIENDS', fr: 'INVITER DES AMIS' },
  // A friend on the board who has no recorded score today (user-decided 2026-08-20):
  // the row stays — an edge is a person you chose — and this label sits where their
  // score would.
  boardNotPlayed: { en: 'NOT PLAYED YET', fr: 'PAS ENCORE JOUÉ' },
  // The line above the invite link when it leaves the app (#189). Lowercase and plain —
  // it travels in a chat between friends, so it reads like something a person would
  // actually type, not marketing copy (user feedback 2026-08-20, replacing "Play
  // Whippin AI with me:").
  boardInviteText: {
    en: 'add me on Whippin:',
    fr: 'ajoute-moi sur Whippin :',
  },
  // The invite landing's confirmation (#189, user feedback 2026-08-20 — the click used
  // to continue into the game without a word, leaving the clicker unsure anything
  // happened): the inviter's mark + name above this line, PLAY below it.
  inviteAdded: { en: 'FRIEND ADDED', fr: 'AMI AJOUTÉ' },
  failedBoard: { en: 'FAILED TO LOAD LEADERBOARD', fr: 'ÉCHEC DU CHARGEMENT DU CLASSEMENT' },
  ariaLeaderboard: { en: 'Leaderboard', fr: 'Classement' },
} satisfies Record<string, Record<UiLang, string>>;

export type UiKey = keyof typeof STRINGS;

export function t(lang: string, key: UiKey): string {
  return STRINGS[key][uiLang(lang)];
}

// The solved credit's KIND, localized. It lives OUTSIDE `STRINGS` because it is not a UI
// key at all: `source.kind` is puzzle DATA and an explicitly OPEN set (#5 — generation may
// emit a kind nobody has listed yet, and one published fr puzzle already carries a
// free-form `discours`). So this is a lookup with a PASS-THROUGH, not a table the caller
// must key into: a known kind is said in the player's language, and anything else prints
// the value the puzzle carries. Uppercase either way — the kind is the label half of
// `BOOK by Victor Hugo`, against that phrase's one lowercase word.
const SOURCE_KINDS = {
  book: { en: 'BOOK', fr: 'LIVRE' },
  movie: { en: 'MOVIE', fr: 'FILM' },
  music: { en: 'MUSIC', fr: 'MUSIQUE' },
  quote: { en: 'QUOTE', fr: 'CITATION' },
  poem: { en: 'POEM', fr: 'POÈME' },
} satisfies Record<string, Record<UiLang, string>>;

export function sourceKind(lang: string, kind: string): string {
  const known = SOURCE_KINDS[kind.trim().toLowerCase() as keyof typeof SOURCE_KINDS];
  return known ? known[uiLang(lang)] : kind.toLocaleUpperCase(uiLang(lang));
}

// The same lookup for a string carrying a COUNT (`{n}` — the table's one placeholder).
// It exists so a number that lives in the code can be shown to the player WITHOUT being
// written into the copy: the caller passes the constant, and retuning it moves the
// sentence too. Both translations must spell `{n}`, which the shared table makes a
// compile-time obligation the way it does every other string.
export function tn(lang: string, key: UiKey, n: number): string {
  return t(lang, key).replace('{n}', String(n));
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

// The history modal's title (2026-08-10, keeping the route map's naming): a hole is named
// by its 1-based sentence position among DISTINCT secrets — the run ruler's tick numbers
// (the same numbering the run ruler's ticks and the share row's keycaps use, so two
// occurrences of one secret — which share a rank map — carry the same number).
export function holeTitle(lang: string, n: number): string {
  return uiLang(lang) === 'fr' ? `MOT ${n}` : `WORD ${n}`;
}

// The game's hole-button description (2026-08-10): tapping a hole opens the guess
// HISTORY against that word, so the hint says that and nothing grander.
export function ariaHoleHistory(lang: string, n: number): string {
  return uiLang(lang) === 'fr' ? `Vos essais sur le mot ${n}` : `Your tries on word ${n}`;
}

// The history drawing is decorative (aria-hidden); these carry it in words. Closest first,
// misses last — the same order the line reads bottom to top.
export function srRouteDestination(lang: string, word: string | null): string {
  if (uiLang(lang) === 'fr') return `destination : ${word ?? 'cachée'}`;
  return `destination: ${word ?? 'hidden'}`;
}

export function srRouteStop(
  lang: string,
  stop: {
    rank: number;
    word: string | null;
    // What the word board says in a station word's COLOUR (#163). Untranslated like the
    // grades are everywhere else on screen — one word per grade, identical in every language.
    rarity?: string;
    start?: boolean;
    best?: boolean;
    // The history line's backwards stretch: farther than the departure, said in prose the
    // way the drawing says it with the dashes.
    behind?: boolean;
  },
): string {
  const fr = uiLang(lang) === 'fr';
  const parts = [fr ? `rang ${stop.rank}` : `rank ${stop.rank}`];
  parts.push(stop.word ?? (fr ? 'caché' : 'hidden'));
  if (stop.rarity) parts.push(stop.rarity);
  if (stop.start) parts.push(fr ? 'départ' : 'start');
  if (stop.best) parts.push(fr ? 'vous êtes ici' : 'you are here');
  if (stop.behind) parts.push(fr ? 'derrière le départ' : 'behind the start');
  return parts.join(' — ');
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

// The board's census: what the sighted player reads off the station words' colours is how the
// field is DISTRIBUTED across the rarity ladder — where the expensive words were. Stated as a
// count rather than item by item: a few hundred entries of "rank 87, hidden" would bury the
// words the player actually knows. The grade names are untranslated, exactly as they are on
// screen; the prose around them is the reader's own language.
export function srWordRarities(
  lang: string,
  perGrade: readonly { grade: string; count: number }[],
  found: number,
): string {
  const total = perGrade.reduce((n, g) => n + g.count, 0);
  const split = perGrade.map((g) => `${g.grade} ${g.count}`).join(', ');
  return uiLang(lang) === 'fr'
    ? `voisinage : ${total} arrêts par rareté (${split}), ${found} trouvés`
    : `neighborhood: ${total} stops by rarity (${split}), ${found} found`;
}

// The END SCREEN's breakdown, the visible chip row said in words: each grade the run
// claimed and its count, ladder order (zero grades are not on screen either). The grade
// names are untranslated, exactly as they are on screen; the prose is the reader's own.
export function srWordBreakdown(
  lang: string,
  perGrade: readonly { grade: string; count: number }[],
): string {
  const split = perGrade.map((g) => `${g.grade} ${g.count}`).join(', ');
  return uiLang(lang) === 'fr' ? `par rareté : ${split}` : `by rarity: ${split}`;
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

// The same clock BEFORE the run starts, when it previews the full length: "N seconds
// left" would claim a countdown is running, and it is not — the gate's clock is a fact
// about the run ahead, not time draining away.
export function srWordClockIdle(lang: string, seconds: number): string {
  if (uiLang(lang) === 'fr') return `chrono de ${seconds} secondes`;
  return `${seconds}-second clock`;
}

// The run's end, announced once when the clock reaches zero.
export function srWordTimeUp(lang: string, total: number): string {
  if (uiLang(lang) === 'fr') return `temps écoulé — ${total} mots`;
  return `time up — ${total} words`;
}
