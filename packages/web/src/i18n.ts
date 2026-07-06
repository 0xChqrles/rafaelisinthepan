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
  changeLanguage: { en: 'CHANGE LANGUAGE', fr: 'CHANGER DE LANGUE' },
  selectLanguage: { en: 'SELECT LANGUAGE', fr: 'CHOISIS TA LANGUE' },
  srLangSolved: { en: 'solved', fr: 'résolu' },
  notAWord: { en: 'this word does not exist', fr: "ce mot n'existe pas" },
  // The score unit stays NAMED in both languages (lower is better must survive the
  // share card); the share text lowercases these.
  try: { en: 'TRY', fr: 'ESSAI' },
  tries: { en: 'TRIES', fr: 'ESSAIS' },
  share: { en: 'SHARE', fr: 'PARTAGER' },
  copied: { en: 'COPIED', fr: 'COPIÉ' },
  nextPuzzleIn: { en: 'NEXT PUZZLE IN', fr: 'PROCHAIN PUZZLE DANS' },
  srSolvedAll: { en: 'sentence solved!', fr: 'phrase résolue !' },
  ariaChangeLanguage: { en: 'Change language', fr: 'Changer de langue' },
  ariaKeyboard: { en: 'on-screen keyboard', fr: 'clavier virtuel' },
  ariaEnter: { en: 'enter', fr: 'entrée' },
  ariaBackspace: { en: 'backspace', fr: 'effacer' },
  ariaDash: { en: 'dash', fr: 'tiret' },
  ariaHelp: { en: 'How to play', fr: 'Comment jouer' },
  ariaSkipTutorial: { en: 'Skip tutorial', fr: 'Passer le tutoriel' },
  // ---- tutorial invitation (#51): the tutorial never starts without an action.
  inviteTitle: {
    en: 'New to the game? Learn how to play in 30 seconds.',
    fr: 'Nouveau ici ? Apprends à jouer en 30 secondes.',
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
    fr: '[[w:mer^1]] est le mot le plus proche de [[b:océan]].',
  },
  tutMixed10: {
    en: '[[w:beach^10]] is the 10th closest word to [[b:ocean]].',
    fr: '[[w:plage^10]] est le 10e mot le plus proche de [[b:océan]].',
  },
  tutGuessFar: {
    en: 'Now type [[w:desert^200]].',
    fr: 'Maintenant tape [[w:désert^200]] (sans l\'accent)',
  },
  tutGuessMiss: {
    en: 'Type a completely different word: [[m:music]].',
    fr: 'Tape un mot complètement différent : [[m:musique]].',
  },
  tutGuessCloser: {
    en: '[[m:music]] was a [[m:MISS]] — too far to rank. Now try [[w:boat^50]].',
    fr: '[[m:musique]] était un [[m:MISS]] — trop loin pour être classé. Essaie [[w:bateau^50]].',
  },
  tutFind: {
    en: 'Now type the very first word — the blue one.',
    fr: 'Maintenant, tape le tout premier mot — celui en bleu.',
  },
  tutFindNudge: {
    en: 'Forgot it? It was [[b:ocean]].',
    fr: "Oublié ? C'était [[b:océan]].",
  },
  tutSentence: {
    en: 'This sentence hides TWO words. You are on your own.',
    fr: 'Cette phrase cache DEUX mots. À toi de jouer.',
  },
  // Sits in SHARE's slot on the real solved layout, so it stays as short as SHARE.
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
