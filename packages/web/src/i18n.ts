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
  newBadge: { en: 'NEW', fr: 'NOUVEAU' },
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
  // ---- onboarding tutorial (#51). In guess-step copy, {WORD} is replaced by the
  // script's expected word (uppercased) so the copy can never drift from the script.
  tutIntro: {
    en: 'Each day, one sentence is hiding a few words. Your job: find them.',
    fr: 'Chaque jour, une phrase cache quelques mots. À toi de les retrouver.',
  },
  tutHoles: {
    en: 'The gold words are hints, not answers. The small number is a distance: an AI ranks every word by meaning, and the hint sits that many places from the secret word. 0 = found.',
    fr: "Les mots dorés sont des indices, pas les réponses. Le petit nombre est une distance : une IA classe chaque mot selon son sens, et l'indice est à autant de places du mot secret. 0 = trouvé.",
  },
  tutGuessFar: {
    en: 'Try a word that has nothing to do with the sentence — type {WORD}, then press enter.',
    fr: "Essaie un mot sans aucun rapport avec la phrase — tape {WORD}, puis valide avec entrée.",
  },
  tutAfterFar: {
    en: 'BOTH holes reacted — every guess is tested on every hole at once. MISS means too far to even get a rank.',
    fr: 'Les DEUX trous ont réagi — chaque essai est testé sur tous les trous à la fois. MISS : trop loin pour être classé.',
  },
  tutGuessWarm: {
    en: 'Now type {WORD}.',
    fr: 'Maintenant, tape {WORD}.',
  },
  tutAfterWarm: {
    en: "One word just improved BOTH holes — it isn't a synonym of either secret, it just lives in the same world. Hunt for context, not synonyms.",
    fr: "Un seul mot vient d'améliorer les DEUX trous — ce n'est le synonyme d'aucun des deux secrets, il vit juste dans le même univers. Cherche le contexte, pas des synonymes.",
  },
  tutGuessSolveOne: {
    en: 'The first word is close now… type {WORD}.',
    fr: 'Le premier mot est tout proche… tape {WORD}.',
  },
  tutAfterSolveOne: {
    en: 'Found! A solved word locks in. The other hole showed its distance but kept its word — a hole always keeps your CLOSEST guess.',
    fr: "Trouvé ! Un mot résolu se verrouille. L'autre trou a affiché sa distance mais a gardé son mot — un trou garde toujours ton essai le PLUS PROCHE.",
  },
  tutGuessSolveAll: {
    en: 'Finish it — type {WORD}.',
    fr: 'Termine — tape {WORD}, sans accent.',
  },
  tutAfterSolveAll: {
    en: 'Sentence solved!',
    fr: 'Phrase résolue !',
  },
  tutWrapTries: {
    en: 'The big number counts your tries — fewer is better, and misses count too. Guess thoughtfully.',
    fr: "Le grand nombre compte tes essais — moins il y en a, mieux c'est, et les MISS comptent aussi. Réfléchis bien.",
  },
  tutWrapProgress: {
    en: 'This bar tracks the whole sentence. The real puzzle hides 3 words. Good luck!',
    fr: 'Cette barre suit la phrase entière. Le vrai puzzle cache 3 mots. Bonne chance !',
  },
  tutNext: { en: 'NEXT', fr: 'SUIVANT' },
  tutSkip: { en: 'SKIP', fr: 'PASSER' },
  tutPlay: { en: "PLAY TODAY'S PUZZLE", fr: 'JOUER AU PUZZLE DU JOUR' },
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
