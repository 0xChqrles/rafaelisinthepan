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
  // The sentence round's own state (#214). The board is a replay of the SERVER's log, so a
  // read that could not be had is a game that cannot honestly start — loud, with a retry,
  // rather than a guessed local board the player would then type answers to.
  failedRound: { en: 'FAILED TO LOAD ROUND', fr: 'ÉCHEC DU CHARGEMENT DE LA PARTIE' },
  // The #188 profile read. Its failure is NOT silent like background round sync: what
  // the server holds is the editor's whole starting point, so a guess could be saved
  // over the real profile — the reader retries instead.
  failedProfile: { en: 'FAILED TO LOAD PROFILE', fr: 'ÉCHEC DU CHARGEMENT DU PROFIL' },
  failedAccountLoad: { en: 'FAILED TO LOAD ACCOUNT', fr: 'ÉCHEC DU CHARGEMENT DU COMPTE' },
  // The #211 private history read, behind the archive calendar and the chooser strips.
  // Loud like the round's own: since #214 there is no local history left to fall back to,
  // so a silent failure would draw a month of untouched days over a month that was played.
  failedHistory: { en: 'FAILED TO LOAD HISTORY', fr: "ÉCHEC DU CHARGEMENT DE L'HISTORIQUE" },
  // The same read failing on a REVALIDATION, where an older answer is still on screen. It
  // needs its own words: a month is drawn, so "failed to load" would be plainly false, and
  // the thing the reader has to know is that what they are looking at may be out of date.
  staleHistory: { en: 'HISTORY MAY BE OUT OF DATE', fr: 'HISTORIQUE PEUT-ÊTRE OBSOLÈTE' },
  // The #271 group invite's write, loud for the same reason: it is the one thing that
  // tap existed to do, so losing it silently would leave everyone none the wiser.
  failedJoin: { en: 'FAILED TO JOIN', fr: "ÉCHEC DE L'ADHÉSION" },
  // A group write that did not land (create, leave, remove) — the same loudness.
  failedGroup: { en: 'FAILED', fr: 'ÉCHEC' },
  failedGroupNote: {
    en: 'The group was not changed. Check your connection and try again.',
    fr: "Le groupe n'a pas été modifié. Vérifiez votre connexion et réessayez.",
  },
  // Neither the native sheet nor the clipboard could deliver (insecure context, denied
  // clipboard, a spent activation): the one share whose silence reads as a dead button.
  // On the error surface, whose TRY AGAIN shares inside its own fresh activation — which
  // is what makes the single-tap INVITE honest (user-decided 2026-08-24: one tap, and the
  // rare stale-activation failure is SAID, with the retry that cures it).
  failedShare: { en: 'SHARE FAILED', fr: 'ÉCHEC DU PARTAGE' },
  failedShareNote: {
    en: 'The link could not be shared or copied. Try again — the next tap shares directly.',
    fr: "Le lien n'a pas pu être partagé ni copié. Réessayez — le prochain appui partage directement.",
  },
  // The refusals a player can act on, so they are the refusals that speak (#271). Asking
  // again cannot change them — a full group is a state, not a hiccup — so this reads as a
  // fact and its button plays rather than retries. ONE line for both caps: the group is
  // full, or the clicker is in too many groups; either way this group is not joinable now.
  groupFull: { en: 'GROUP FULL', fr: 'GROUPE COMPLET' },
  // The caller's own cap, on a create or a join from the board.
  groupLimit: { en: 'TOO MANY GROUPS', fr: 'TROP DE GROUPES' },
  groupLimitNote: {
    en: 'Leave a group to join or create another one.',
    fr: 'Quittez un groupe pour en rejoindre ou en créer un autre.',
  },
  retry: { en: 'RETRY', fr: 'RÉESSAYER' },
  // The error screen's way OUT (2026-08-27, when the sheet became a full-screen modal).
  // It is not "close" — nothing is being tidied away; the act did not happen and the player
  // is going back to the screen that asked for it.
  errorDismiss: { en: 'GO BACK', fr: 'RETOUR' },
  // The five deploy buttons' failures, on the error screen: the TITLE says what failed in
  // the chrome voice, the NOTE explains it in a sentence (the coach-copy exemption from
  // the all-caps rule). TWO clauses, never three (user-decided 2026-08-27): what happened,
  // then what to do. The note used to add "so nothing was saved" — true, but it answers a
  // worry the player has not had yet, and on a screen whose whole job is to get them to
  // press TRY AGAIN it spends the reader's attention on reassurance instead of the act.
  failedAccount: { en: 'ACCOUNT SETUP FAILED', fr: 'ÉCHEC DE LA CRÉATION DU COMPTE' },
  failedAccountNote: {
    en: 'Your account could not be set up. Check your connection and try again.',
    fr: "Votre compte n'a pas pu être créé. Vérifiez votre connexion et réessayez.",
  },
  failedJoinNote: {
    en: 'You did not join the group. Check your connection and try again.',
    fr: "Vous n'avez pas rejoint le groupe. Vérifiez votre connexion et réessayez.",
  },
  failedSaveNote: {
    en: 'Your profile was not saved. Check your connection and try again.',
    fr: "Votre profil n'a pas été enregistré. Vérifiez votre connexion et réessayez.",
  },
  profileNameRejectedNote: {
    en: 'This name is not allowed. Pick another one and save again.',
    fr: "Ce nom n'est pas autorisé. Choisissez-en un autre et réenregistrez.",
  },
  profileAvatarRejectedNote: {
    en: 'This drawing is not allowed. Change it and save again.',
    fr: "Ce dessin n'est pas autorisé. Modifiez-le et réenregistrez.",
  },
  // Signed out from another device (#216). It is a SCREEN, not an error line: the account
  // is intact and reachable, this device simply no longer holds it. The screen shows the
  // ACCOUNT's mark and name above this caption (the invite landing's shape), so the line
  // reads under WHO it is about — which is why it no longer says "from this device".
  signedOut: { en: 'SIGNED OUT', fr: 'DÉCONNECTÉ' },
  // ONE REASSURING SENTENCE about the BUTTON (user-decided 2026-08-26, in two passes:
  // first superseding a paragraph that listed what the account holds, then given the
  // TONE — "pas de panique, un nouveau compte a été créé pour que vous puissiez continuer
  // à jouer"). Being signed out is alarming, so the line opens by saying it is fine, then
  // says the two things the tap does: a new account, and starting from scratch. The
  // reason to keep playing is the BUTTON's own word, so the sentence does not restate it.
  // Written in the FUTURE the tap opens, never the past — the account is minted by the
  // game's own PLAY gate the tap lands on, so "has been created" would be a screen
  // claiming something that has not happened yet.
  // AMENDED by #204's review: it described the SECONDARY, and contradicted the primary
  // that now leads. RECONNECT signs back into the account named above; the sentence under
  // it read "playing creates a new account and you start from scratch", which is the one
  // thing reconnecting does NOT do — so a reader scanning primary-then-note met a
  // contradiction on the screen that has to be clearest. It names neither button (both are
  // right there): it says the account is still reachable, and what the other tap costs.
  signedOutNote: {
    en: "Don't worry — this account is still there. Playing instead starts a new one, from scratch.",
    fr: 'Pas de panique : ce compte existe toujours. Jouer démarre plutôt un nouveau, de zéro.',
  },
  // The account's devices, on the profile editor (#216): the surface the whole issue exists
  // for, since signing a device out has to be possible without holding that device.
  devicesTitle: { en: 'DEVICES', fr: 'APPAREILS' },
  deviceCurrent: { en: 'THIS ONE', fr: 'CELUI-CI' },
  deviceSignOut: { en: 'SIGN OUT', fr: 'DÉCONNECTER' },
  // The UA parser leaves what it cannot read EMPTY rather than guessing, so the SCREEN names
  // an unlabelled device.
  deviceUnknown: { en: 'UNKNOWN DEVICE', fr: 'APPAREIL INCONNU' },
  failedDevices: { en: 'FAILED TO LOAD DEVICES', fr: 'ÉCHEC DU CHARGEMENT DES APPAREILS' },
  signedOutReconnect: { en: 'RECONNECT', fr: 'SE RECONNECTER' },
  // THE ACCOUNT AREA (#204, reworked 2026-08-26). One purpose per screen, and one rule for
  // the words: a line survives only if it says something the screen does not already show.
  // So there is no "YOUR ACCOUNT" over a screen titled ACCOUNT, no "SAVED AS" in front of
  // something plainly an email, and no "6-DIGIT CODE" over six cells.
  // An invite link naming no group (#271). It is a STATE, not a failure: there is nothing
  // to retry, so the screen says so and carries the reader into the game.
  inviteExpired: { en: 'THIS INVITE LINK HAS EXPIRED', fr: "CE LIEN D'INVITATION A EXPIRÉ" },
  accountTitle: { en: 'ACCOUNT', fr: 'COMPTE' },
  // The account's own age, prefixed once — the only thing this screen can say about an
  // identity whose name and mark it already draws.
  accountSave: { en: 'SAVE WITH EMAIL', fr: 'SAUVEGARDER PAR E-MAIL' },
  // THE ONE LINE THAT EARNS ITS PLACE: why a word game wants an email is genuinely not
  // obvious, so it is said once, where the decision is made — and it says it PLAINLY.
  // (User-decided 2026-08-28, superseding "Pour qu'un téléphone perdu ne perde pas tout.":
  // the loss framing turned on a play on words — perdu/perde — which is the opposite of
  // plain, and read as cringe rather than as stakes. What a player actually pictures is
  // getting a new device, so the line names that.)
  //
  // APPAREIL rather than téléphone is the user's own word and stays: it is what the device
  // list already prints (`devicesTitle`), so the note and the list name one thing.
  //
  // TON became VOTRE (review finding). It was the app's first tutoiement, and it landed in
  // an area that says vous five times within two taps of it — « Réessayez », « Demandez-en
  // un nouveau », « vos amis vous suivent », « Vous êtes déjà sur ce compte ». One sentence
  // in the other register does not read as warmth, it reads as an inconsistency, and this
  // is the one line on the screen a player is meant to weigh a decision against. The voice
  // is still the user's to settle — it is one word either way — but it has to be ONE.
  accountSaveNote: {
    en: 'To get your account back on another device.',
    fr: 'Pour retrouver votre compte sur un autre appareil.',
  },
  // THE PRIVACY NOTICE (#229). ONE word for one thing: it names the screen in the header,
  // and it names the row on `/account` that leads there — a row whose label and its
  // destination's title should be the same word, or the tap reads as going somewhere else.
  // fr VIE PRIVÉE rather than CONFIDENTIALITÉ: plainer, and five characters shorter in a
  // header slot that ellipsises at 320px (the `linkTitleReturn` finding).
  privacyTitle: { en: 'PRIVACY', fr: 'VIE PRIVÉE' },

  // WHAT SCREEN THIS IS. `back` renders the CURRENT screen's name as the way out of it —
  // `/account` says ACCOUNT and `/profile` says PROFILE — and the flow was passing
  // `accountTitle`, its PARENT's. On the returning door that left a screen whose entire
  // text was the word CONTINUE: a churning tile, an unlabelled field, and a header naming
  // somewhere else. The door's declared intention is the one thing it can honestly say.
  // SAVE / SAUVEGARDE, shortened 2026-09-03 when the language joined the title: `SAVE
  // ACCOUNT` is 12 glyphs, and the row holds ~9 beside a back arrow, a language tag and a
  // chevron. It is `linkTitleReturn`'s own finding one door over (SE CONNECTER → CONNEXION,
  // 2026-08-31) — and it leaves the two doors a matched pair in each language: a verb and a
  // verb phrase in English, two nouns in French.
  linkTitleSave: { en: 'SAVE', fr: 'SAUVEGARDE' },
  // fr CONNEXION rather than SE CONNECTER (2026-08-31): the title has ONE size on every
  // screen, and at 320px the longer spelling ran into the header's fixed five keys.
  linkTitleReturn: { en: 'SIGN IN', fr: 'CONNEXION' },

  linkAddressPlaceholder: { en: 'EMAIL', fr: 'E-MAIL' },
  linkContinue: { en: 'CONTINUE', fr: 'CONTINUER' },
  // Where it went — the answer to "did I typo my own address?", which is the one thing the
  // player cannot check for themselves.
  linkSentTo: { en: 'Sent to', fr: 'Envoyé à' },
  // The code prompt's ACCESSIBLE name. The six cells are decoration (aria-hidden), so this
  // is what a screen reader announces for the one real input — it is deliberately NOT on
  // screen, where the cells already demonstrate what is wanted.
  linkCodeLabel: { en: '6-digit code', fr: 'Code à 6 chiffres' },
  linkResend: { en: 'RESEND', fr: 'RENVOYER' },
  // Shown only once an attempt has been SPENT: stating the budget up front reads as a
  // warning to somebody who has typed nothing wrong. One line, at the input, beside the
  // cells that just shook.
  linkWrongCode: { en: 'Wrong code — {n} left', fr: 'Code incorrect — {n} restants' },
  // The last attempt before the code is spent. Two keys and a caller-side `n === 1`, the
  // shape TRY/TRIES already uses — French disagrees where English does not (« 1 restant »,
  // "1 left"), and the pair keeps both languages in the type-checked table.
  linkWrongCodeOne: { en: 'Wrong code — 1 left', fr: 'Code incorrect — 1 restant' },
  linkCancel: { en: 'CANCEL', fr: 'ANNULER' },
  // The BIND ending's way back to the account screen: a settings errand ends where it
  // began, and OK is the one word that is chrome in both languages. The ADOPT ending keeps
  // PLAY — a recovered player wants their game, not a settings screen.
  linkDone: { en: 'OK', fr: 'OK' },
  // The erase confirmation. It NAMES what the tap destroys — the server refuses to erase
  // without being told which account, and this screen is the only thing between that tap
  // and a month of play.
  // THE CROSSROADS (#204's UX rework vol. 2). The confirmation used to STATE the deletion —
  // "This device is on another account. Linking deletes it." — while showing only the account
  // being lost. It now SHOWS the fork instead: two marks, the one being left struck through
  // under the word DELETED, the one being joined lit beside it. So the sentence is free to
  // carry the only part the screen cannot draw — what SURVIVES. Both halves are true and
  // neither is obvious: the active day's play moves across, and the friends graph is merged.
  // A confirmation that overstates the damage misleads exactly as much as one that hides it.
  linkEraseKeeps: {
    en: "Today's game comes with you. Your groups and the rest are lost.",
    fr: 'La partie du jour vous suit. Vos groupes et le reste sont perdus.',
  },
  linkEraseDeleted: { en: 'DELETED', fr: 'SUPPRIMÉ' },
  // Reached from the SAVE door, the crossroads is a genuine surprise — the player asked to
  // keep something and is being shown a deletion. One line explains the turn before the
  // screen asks anything. From the RETURN door it is omitted: the address step already said
  // this, and repeating it there would read as a scolding.
  linkEraseFound: {
    en: 'That address already has an account.',
    fr: 'Cette adresse a déjà un compte.',
  },
  // THE SWITCH, which is the same crossroads with nothing destroyed on it. What it has to
  // say is what happens to the account being left — since the picture shows the leaving, and
  // "deleted" is exactly what is NOT happening here.
  linkSwitchKeeps: {
    en: 'Nothing is deleted — this account stays saved under its own address.',
    fr: "Rien n'est supprimé — ce compte reste sauvegardé sous sa propre adresse.",
  },
  linkSwitchConfirm: { en: 'SWITCH ACCOUNT', fr: 'CHANGER DE COMPTE' },
  // THE ACCOUNT'S THREE NUMBERS, one word each, shared by every surface that states them —
  // the account screen and the erase/switch confirmations. They were `linkEraseStreak` /
  // `linkEraseDays` while only the dialog said them, and the streak one rendered « SÉRIE »
  // there against the archive's « STREAK » for the same number: two French words for one
  // thing, on screens that now sit one tap apart. Unified on the older, game-facing one —
  // STREAK is untranslated vocabulary here, the family MISS belongs to.
  statDays: { en: 'DAYS', fr: 'JOURS' },
  // The longest run the account has ever held, beside the one it is on. RECORD rather than
  // « MEILLEUR »: it is the word a French player would use for a personal best, and it is
  // short enough to sit under a number in a three-up row.
  statBest: { en: 'BEST', fr: 'RECORD' },
  linkEraseConfirm: { en: 'DELETE AND CONTINUE', fr: 'SUPPRIMER ET CONTINUER' },
  // The two endings, in #204's own decided words: one for an address nobody knew, one for
  // an account the player is coming back to. Both land under the account's own FACE, which
  // is the claim "we found your account" actually makes.
  linkSaved: { en: 'Account saved.', fr: 'Compte sauvegardé.' },
  linkRestored: { en: 'We found your account.', fr: 'On a retrouvé votre compte.' },
  // THE FOUR OTHER ENDINGS. Six cells exist — two doors times three outcomes — and until
  // vol. 2 four of them borrowed one of the two sentences above. `already_bound` claimed
  // "Compte sauvegardé." for a no-op, and a RETURN that found nothing said it too, under the
  // very face the player was hoping to replace, with no explanation at all.
  linkAlreadyAddress: {
    en: 'Already saved to this address.',
    fr: 'Déjà sauvegardé sous cette adresse.',
  },
  linkAlreadyAccount: {
    en: "You're already on this account.",
    fr: 'Vous êtes déjà sur ce compte.',
  },
  linkFailed: { en: 'LINK FAILED', fr: 'ÉCHEC DE LA LIAISON' },
  linkTooMany: {
    en: 'Too many codes asked for. Try again in a while.',
    fr: 'Trop de codes demandés. Réessayez dans un moment.',
  },
  linkBadAddress: {
    en: "That address doesn't look right.",
    fr: 'Cette adresse ne semble pas valide.',
  },
  linkSendFailedNote: {
    en: 'The code could not be sent.',
    fr: "Le code n'a pas pu être envoyé.",
  },
  linkVerifyFailedNote: {
    en: 'The code could not be checked.',
    fr: "Le code n'a pas pu être vérifié.",
  },
  linkCodeSpent: {
    en: 'Too many wrong codes. Ask for a new one.',
    fr: 'Trop de codes incorrects. Demandez-en un nouveau.',
  },
  linkCodeExpired: {
    en: 'That code has expired. Ask for a new one.',
    fr: 'Ce code a expiré. Demandez-en un nouveau.',
  },
  // An account carries at most ONE address, so a device whose account is already saved under
  // a different one cannot bind a second (the old address would reach an account nobody
  // could ever sign into again). It is a FACT about this account, not a failure: it says so
  // AT the address field with the field still there to type in — a modal would be a dead end
  // on a screen whose one remaining move is to try another address.
  //
  // **THE REFUSAL IS ONE, THE SITUATION IS TWO** (user-decided 2026-08-28). The server
  // answers `account_linked` in exactly one case: the address reaches NOBODY, and this
  // device's account already has one of its own. Which of those two facts the player needs
  // depends entirely on which door they came through, and the SAVE wording was being shown
  // to both — so a player trying to SIGN IN was told about a binding they had not asked for
  // ("this account is already saved elsewhere") instead of the answer to what they actually
  // did. From the RETURN door the true and useful half is the other one: there is nobody at
  // that address. Both statements are exactly true of the same refusal; the door decides
  // which one is an answer.
  linkAlreadySaved: {
    en: 'This account is already saved under another address.',
    fr: 'Ce compte est déjà sauvegardé sous une autre adresse.',
  },
  // The RETURNING door's answer when nobody is at the address. It used to be an ENDING —
  // the account this device held got bound to the address instead, and the screen explained
  // the turn — until 2026-08-28, when the user pointed out that binding is not a smaller
  // version of recovering: a player who typed a wrong address would SPEND their account's
  // one address slot on it. Nothing happens now, and this is a note at the field with the
  // field still there to correct.
  linkNoAccountThere: {
    en: 'No account is saved at that address.',
    fr: "Aucun compte n'est sauvegardé à cette adresse.",
  },
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
  // What a calendar cell or a chooser card says when its private summary (#211) has not
  // arrived. The visual placeholder says "not yet" by breathing; silence would read as
  // "not started", which is the one thing an unloaded day must never claim.
  srStatusUnknown: { en: 'status not loaded', fr: 'statut non chargé' },
  notAWord: { en: 'this word does not exist', fr: "ce mot n'existe pas" },
  // The score unit stays NAMED in both languages (lower is better must survive the
  // share card); the share text lowercases these.
  try: { en: 'TRY', fr: 'ESSAI' },
  tries: { en: 'TRIES', fr: 'ESSAIS' },
  // What hangs off every header title (2026-09-03): the LANGUAGE selection.
  langMenu: { en: 'Change language', fr: 'Changer de langue' },
  share: { en: 'SHARE', fr: 'PARTAGER' },
  copied: { en: 'COPIED', fr: 'COPIÉ' },
  // The result screen's ONE onward action (#273): tomorrow's sentence, tonight.
  tomorrow: { en: 'TOMORROW', fr: 'DEMAIN' },
  // …and the way back from it, under the night's countdown: today's result.
  today: { en: 'TODAY', fr: "AUJOURD'HUI" },
  // A music day's track link on the solved page (#270): an ordinary link, new tab.
  listen: { en: 'LISTEN', fr: 'ÉCOUTER' },
  // The solved credit block's one function word (user-decided 2026-08-15): it binds the
  // author to the work in the line under it — `Les Misérables` / `BOOK by Victor Hugo` can
  // only be read one way, where two stacked names could be read either. LOWERCASE, unlike
  // every other string here: it is the one word in this app that is not a label but part
  // of a phrase, and the KIND beside it is uppercased in code to keep that contrast. Drawn
  // only when BOTH a work and an author exist; a lone author is a name, not a credit, and
  // takes the headline itself.
  sourceBy: { en: 'by', fr: 'de' },
  ariaClose: { en: 'close', fr: 'fermer' },
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
  // What the guess PROMPT's own field is called (#267). The line the player reads is a
  // drawing of its value, hidden from assistive tech; this names the thing that holds it.
  ariaGuess: { en: 'your guess', fr: 'votre proposition' },
  ariaKeyboard: { en: 'on-screen keyboard', fr: 'clavier virtuel' },
  ariaEnter: { en: 'enter', fr: 'entrée' },
  ariaBackspace: { en: 'backspace', fr: 'effacer' },
  ariaDash: { en: 'dash', fr: 'tiret' },
  ariaHome: { en: "Today's puzzle", fr: 'Puzzle du jour' },
  ariaHelp: { en: 'How to play', fr: 'Comment jouer' },
  // ---- archive calendar (#55): playable past days behind a calendar screen.
  archive: { en: 'ARCHIVE', fr: 'ARCHIVE' },
  ariaArchive: { en: 'Past puzzles', fr: 'Puzzles précédents' },
  // The account area's way OUT, on the header's own title (2026-08-29). The visible words
  // are the screen's NAME; this is what the control is called for a reader.
  ariaBack: { en: 'Back', fr: 'Retour' },
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
  // ---- the LESSON (#51, remade by #269): level 1 is the game, played. The coach is
  // REACTIVE — it speaks on a mistake or a stall, never on success (tutorial/coach.ts) — so
  // every line here is the ONE thing a guess calls for. Deliberately TERSE, no under-the-hood
  // talk. HARD LIMIT: the coach box is exactly 3 lines and clips — a string that wraps past
  // three lines (~60 chars incl. exponents at the mobile width) is too much: cut it.
  // Copy uses CoachText's inline markup so words LOOK like what they are in-game:
  // [[b:secret]] solve cobalt, [[w:hint^rank]] the held word's chip + rank exponent,
  // [[m:miss]] MISS's red. The {braces} are filled by coach.ts from the board itself, so a
  // line can never name a word the map does not rank.
  // The lines are written for someone who knows NOTHING yet (user-decided 2026-09-16, five
  // passes — "where is the secret word? what does 'mer est le plus proche' mean?"): nothing
  // is said that the player has not just SEEN. The reveal shows the secret word, then hides
  // it behind its closest word in front of them; every later line names what is on screen.
  // coach.ts fills the {braces} (`ordinal` for the ranks).
  tutReveal: { en: 'Here is a secret word: {answer}.', fr: 'Voici un mot secret : {answer}.' },
  // The reveal's one action, a button in the tray: what pressing it does.
  tutHide: { en: 'HIDE THE WORD', fr: 'MASQUER LE MOT' },
  tutHidden: {
    en: 'It is hidden now. In its place, its closest word: {start}. Type the secret word.',
    fr: 'Le voilà caché. À sa place, son mot le plus proche : {start}. Retape le mot secret.',
  },
  tutIntro: {
    en: 'Another secret word. In its place, the {m} closest word: {start}. Find it.',
    fr: 'Un autre mot secret. À sa place, le {m} mot le plus proche : {start}. Trouve-le.',
  },
  tutSentenceIntro: {
    en: 'Now a sentence, with two secret words. Find them.',
    fr: 'Maintenant une phrase, avec deux mots secrets. Trouve-les.',
  },
  // The sentence solved: the bot counts the tries — the score, said once — and says this one
  // was easy where the daily sentences are harder (user-decided 2026-09-16): the hook the
  // first-letter lesson will hang from.
  tutSolved: {
    en: 'You found both in {n} tries. This one was easy: the daily sentences are harder.',
    fr: 'Trouvés en {n} essais ! Celle-ci était facile, les vraies phrases sont plus dures.',
  },
  // CONTINUE leads from that line into the meter stage — the one control, named for what
  // it does (never "tap anywhere").
  tutContinue: { en: 'CONTINUE', fr: 'CONTINUER' },
  // THE METER STAGE (#301 taught; scripted, user-decided 2026-09-16): the bot has half
  // played the sentence. Its lines follow the player's acts — the tap, the first close
  // guess, one more try — and it names the answer as if it had found it.
  tutMeterIntro: {
    en: 'I already played a bit. Tap {word} to see my tries.',
    fr: "J'ai déjà un peu joué. Touche {word} pour voir mes essais.",
  },
  tutMeterTapped: {
    en: 'My close tries filled the word up. Full, it reveals the first letter. Try one!',
    fr: 'Mes essais proches ont rempli le mot. Plein, il révèle la première lettre. Essaie !',
  },
  tutLetter: {
    en: 'Full! The secret word starts with {letter}. Your turn: try a word.',
    fr: 'Plein ! Le mot secret commence par {letter}. À toi : essaie un mot.',
  },
  tutMeterFound: {
    en: 'You found it! You are ready for the real game.',
    fr: 'Trouvé ! Tu es prêt pour le vrai jeu.',
  },
  tutMeterBot: {
    en: 'Got it, it was {answer}! You are ready for the real game.',
    fr: "Ça y est, c'était {answer} ! Tu es prêt pour le vrai jeu.",
  },
  tutAway: {
    en: '{guess} is the {n} closest word to the secret. {start} is the {m}.',
    fr: '{guess} est le {n} mot le plus proche du secret. {start} est le {m}.',
  },
  tutMiss: {
    en: '{miss} is too far from the secret to even get a number.',
    fr: '{miss} est trop loin du secret pour avoir un nombre.',
  },
  tutNear: {
    en: 'Try words with a meaning close to {word}.',
    fr: 'Essaie des mots au sens proche de {word}.',
  },
  tutAnswer: { en: 'The secret word is {answer}. Type it.', fr: 'Le mot secret est {answer}. Tape-le.' },
  // The sentence's one mechanic worth a line, in the input device's own verb (the
  // tapAnywhere/clickAnywhere pattern).
  tutTap: {
    en: 'Tap a highlighted word to see your previous tries on it.',
    fr: 'Touche un mot surligné pour revoir tes essais précédents.',
  },
  tutClick: {
    en: 'Click a highlighted word to see your previous tries on it.',
    fr: 'Clique sur un mot surligné pour revoir tes essais précédents.',
  },
  // Each board's own hint about its word — what the coach says once a hole has resisted long
  // enough, before it gives the answer (scripts/<lang>.ts names them per hole).
  tutHintOcean: { en: 'A very large body of water.', fr: 'Une très grande étendue d’eau.' },
  tutHintMountain: { en: 'It is very high, and you climb it.', fr: 'C’est très haut, et ça se grimpe.' },
  tutHintMontagne: { en: 'It is very high, and you climb it.', fr: 'C’est très haut, et ça se grimpe.' },
  tutHintDog: { en: 'Man’s best friend.', fr: 'Le meilleur ami de l’homme.' },
  tutHintMoon: { en: 'It lights the night.', fr: 'Elle éclaire la nuit.' },
  tutHintChien: { en: 'Man’s best friend.', fr: 'Le meilleur ami de l’homme.' },
  tutHintCat: { en: 'It purrs.', fr: 'Il ronronne.' },
  tutHintChat: { en: 'It purrs.', fr: 'Il ronronne.' },
  tutHintLiberty: { en: 'Being free.', fr: 'Être libre.' },
  tutHintSentier: { en: 'A narrow path.', fr: 'Un petit chemin.' },
  tutHintLune: { en: 'It lights the night.', fr: 'Elle éclaire la nuit.' },
  // The lesson's wordless ending: the solved sentence stands, and PLAY graduates into the game.
  tutPlay: { en: 'PLAY', fr: 'JOUER' },
  // ---- the LEVELS list (#269): the tutorial page, one row per level (tutorial/levels.ts).
  learnTitle: { en: 'TUTORIAL', fr: 'TUTORIEL' },
  levelPlayTitle: { en: 'THE GAME', fr: 'LE JEU' },
  levelPlaySub: { en: 'Guess the secret words', fr: 'Deviner les mots secrets' },
  levelDistanceTitle: { en: 'THE DISTANCE', fr: 'LA DISTANCE' },
  levelDistanceSub: { en: 'How closeness is measured', fr: 'Comment la proximité se mesure' },
  levelMeaningsTitle: { en: 'MANY MEANINGS', fr: 'PLUSIEURS SENS' },
  levelMeaningsSub: { en: 'One word, several places', fr: 'Un mot, plusieurs places' },
  levelVectorsTitle: { en: 'UNDER THE HOOD', fr: 'SOUS LE CAPOT' },
  levelVectorsSub: { en: 'Vectors, and what AIs do with them', fr: 'Les vecteurs, et ce que les IA en font' },
  levelDone: { en: 'Done', fr: 'Fait' },
  levelSoon: { en: 'SOON', fr: 'BIENTÔT' },
  // ---- the game's pre-round gate (2026-08-11; #269 made it an INVITATION): until level 1 is
  // done, LEARN opens it and PLAY skips it; a device with no account keeps PLAY as its
  // deploy button.
  gateLearn: { en: 'LEARN', fr: 'APPRENDRE' },
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
  // like MISS and STREAK.
  profileClear: { en: 'CLEAR', fr: 'CLEAR' },
  ariaAvatarEditor: { en: 'Avatar editor: tap to paint', fr: "Éditeur d'avatar : touchez pour peindre" },
  ariaPalette: { en: 'Palette', fr: 'Palette' },
  // ---- the leaderboard screen (#190/#271): the player's GROUPS first, global top 50 as the
  // untrusted tab. Terse chrome in the app's register; the tabs and the rows do the
  // explaining. GLOBAL is one word in both languages, like TOP and the grades.
  boardTitle: { en: 'LEADERBOARD', fr: 'CLASSEMENT' },
  boardGlobal: { en: 'GLOBAL', fr: 'GLOBAL' },
  boardPeriods: { en: 'Period', fr: 'Période' },
  // TODAY, not DAY (user-decided 2026-09-14): the live board is today's, and a period
  // named DAY beside WEEK and MONTH read as "any day".
  periodDay: { en: 'TODAY', fr: "AUJOURD'HUI" },
  periodWeek: { en: 'WEEK', fr: 'SEMAINE' },
  periodMonth: { en: 'MONTH', fr: 'MOIS' },
  // The empty states, one per view (user feedback 2026-08-20: TERSE, under a small sad
  // pixel ghost that carries the mood). No group at all; a group of one — the caller
  // alone, since a member who merely has not played shows as a waiting row; a week or a
  // month in which nobody in the group recorded a score; and the global board's nobody.
  boardEmptyGroups: { en: 'NO GROUP', fr: 'AUCUN GROUPE' },
  boardEmptyGroup: { en: 'JUST YOU', fr: 'QUE VOUS' },
  boardEmptyPeriod: { en: 'NOBODY YET', fr: 'ENCORE PERSONNE' },
  boardEmptyGlobal: { en: 'NOBODY YET', fr: 'ENCORE PERSONNE' },
  boardEdit: { en: 'EDIT', fr: 'MODIFIER' },
  boardInvite: { en: 'INVITE', fr: 'INVITER' },
  // The period rule's numbers: podium POINTS as the unit caption, the tiebreakers as a
  // small detail on the row.
  points: { en: 'POINTS', fr: 'POINTS' },
  dayUnit: { en: 'day', fr: 'jour' },
  daysUnit: { en: 'days', fr: 'jours' },
  // A member on the day board who has no recorded score today (user-decided 2026-08-20):
  // the row stays — a member is a person you chose to play with — and this label sits
  // where their score would.
  boardPlaying: { en: 'IN PROGRESS', fr: 'EN COURS' },
  boardNotPlayed: { en: 'NOT PLAYED YET', fr: 'PAS ENCORE JOUÉ' },
  // The line above the invite link when it leaves the app (#271). Lowercase and plain —
  // it travels in a chat between people who know each other, so it reads like something a
  // person would actually type, not marketing copy (user feedback 2026-08-20).
  boardInviteText: {
    en: 'join my group on Whippin:',
    fr: 'rejoins mon groupe sur Whippin :',
  },
  // A GROUP's own acts (#271): making one, naming it, joining, leaving, and the creator
  // showing a member out. The destructive two confirm by changing their own word.
  groupNew: { en: 'NEW GROUP', fr: 'NOUVEAU GROUPE' },
  groupName: { en: 'Group name', fr: 'Nom du groupe' },
  // Explicit (user-decided 2026-09-14: "CREATE is not very explicit").
  groupCreate: { en: 'CREATE GROUP', fr: 'CRÉER UN GROUPE' },
  groupMembers: { en: 'Members', fr: 'Membres' },
  groupJoin: { en: 'JOIN', fr: 'REJOINDRE' },
  // The landing's confirmation: the group's name and marks above this line, the board and
  // PLAY below it.
  groupJoined: { en: 'JOINED', fr: 'REJOINT' },
  groupLeave: { en: 'LEAVE GROUP', fr: 'QUITTER LE GROUPE' },
  // The board's SCOPE pager (user-decided 2026-09-14, the third control design): a
  // group's page reads its name over its size, GLOBAL's over what it is.
  scopeGlobalSub: { en: 'TOP 50', fr: 'TOP 50' },
  memberUnit: { en: 'MEMBER', fr: 'MEMBRE' },
  membersUnit: { en: 'MEMBERS', fr: 'MEMBRES' },
  groupOwnerTag: { en: 'OWNER', fr: 'CRÉATEUR' },
  groupRemove: { en: 'Remove from the group', fr: 'Retirer du groupe' },
  // The two CONFIRMATIONS (user-decided 2026-09-14: a full-screen modal for both). The
  // title says the act, the note what it means; the button is the act's own word. The
  // owner's leave has three notes, by what the succession rule does (root AGENTS.md).
  groupRemoveTitle: { en: 'REMOVE FROM THE GROUP', fr: 'RETIRER DU GROUPE' },
  groupRemoveNote: {
    en: 'They will no longer see the group. An invite link brings them back.',
    fr: "Cette personne ne verra plus le groupe. Un lien d'invitation la fera revenir.",
  },
  groupRemoveAction: { en: 'REMOVE', fr: 'RETIRER' },
  groupLeaveTitle: { en: 'LEAVE THE GROUP', fr: 'QUITTER LE GROUPE' },
  groupLeaveNote: {
    en: 'You will no longer see the group. An invite link brings you back.',
    fr: "Vous ne verrez plus le groupe. Un lien d'invitation vous fera revenir.",
  },
  groupLeaveLastNote: {
    en: 'You are its last member. The group will be deleted.',
    fr: 'Vous en êtes le dernier membre. Le groupe sera supprimé.',
  },
  groupLeaveHandoverNote: {
    en: 'You created this group. The other member takes it over.',
    fr: "Vous avez créé ce groupe. L'autre membre le reprend.",
  },
  groupLeaveSuccessorNote: {
    en: 'You created this group. Choose who takes it over.',
    fr: 'Vous avez créé ce groupe. Choisissez qui le reprend.',
  },
  groupLeaveAction: { en: 'LEAVE', fr: 'QUITTER' },
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

// The hole's CHARGE METER, in words (#301): the state a screen reader gets where a sighted
// player sees the meter filling under the word, attached to the hole as a description —
// never injected into the sentence itself.
export function srHoleCharge(lang: string, charge: number): string {
  const pct = Math.round(charge);
  return uiLang(lang) === 'fr' ? `jauge à ${pct} %` : `meter at ${pct}%`;
}

// The revealed initial (#301): the persistent clue a full meter earns. With `n`, the live
// announcement the moment it is revealed; without, the hole's standing description.
export function srHoleInitial(lang: string, letter: string, n?: number): string {
  if (uiLang(lang) === 'fr') {
    return n === undefined ? `commence par ${letter}` : `mot ${n} : commence par ${letter}`;
  }
  return n === undefined ? `starts with ${letter}` : `word ${n}: starts with ${letter}`;
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

// The route drawings are decorative (aria-hidden); these carry them in words.
export function srRouteStop(
  lang: string,
  stop: {
    rank: number;
    word: string | null;
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
  if (stop.start) parts.push(fr ? 'départ' : 'start');
  if (stop.best) parts.push(fr ? 'vous êtes ici' : 'you are here');
  if (stop.behind) parts.push(fr ? 'derrière le départ' : 'behind the start');
  return parts.join(' — ');
}

// The early-play countdown (#273): what the clock that took the keyboard's place means —
// the round continues at the day's flip. Whole minutes: it is a wait, not a run.
export function srEarlyClock(lang: string, minutes: number): string {
  if (uiLang(lang) === 'fr') return `La partie reprend dans ${minutes} minutes`;
  return `The round continues in ${minutes} minutes`;
}
