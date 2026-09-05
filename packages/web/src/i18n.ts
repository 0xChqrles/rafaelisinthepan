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
  // The #189 invite link's write, loud for the same reason: it is the one thing that
  // click existed to do, so losing it silently would leave both players none the wiser.
  failedInvite: { en: 'FAILED TO ADD FRIEND', fr: "ÉCHEC DE L'AJOUT EN AMI" },
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
  // Word mode's round start (#202), loud for that same reason and one more: the SERVER
  // stamps the clock, so a failed start is a run that has not begun. Saying nothing would
  // leave the player tapping PLAY at a gate that never opens.
  failedStart: { en: 'FAILED TO START', fr: 'ÉCHEC DU DÉMARRAGE' },
  // The one refusal a player can act on, so it is the one refusal that speaks (#189). Asking
  // again cannot change it — a full list is a state, not a hiccup — so this reads as a fact
  // and its button plays rather than retries. Neutral about WHOSE list: the cap binds either
  // side of the pair, and the clicker cannot tell which.
  friendListFull: { en: 'FRIEND LIST FULL', fr: "LISTE D'AMIS PLEINE" },
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
  failedStartNote: {
    en: 'The round did not start — the clock is not running. Check your connection and try again.',
    fr: "La partie n'a pas démarré — le chrono ne tourne pas. Vérifiez votre connexion et réessayez.",
  },
  failedInviteNote: {
    en: 'The friend was not added. Check your connection and try again.',
    fr: "L'ami n'a pas été ajouté. Vérifiez votre connexion et réessayez.",
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
  // An invite link whose sender's account is gone (#204). It is a STATE, not a failure:
  // there is nothing to retry, so the screen says so and carries the reader into the game.
  inviteExpired: { en: 'THIS INVITE LINK HAS EXPIRED', fr: "CE LIEN D'INVITATION A EXPIRÉ" },
  accountTitle: { en: 'ACCOUNT', fr: 'COMPTE' },
  // The account's own age, prefixed once — the only thing this screen can say about an
  // identity whose name and mark it already draws.
  accountSince: { en: 'SINCE', fr: 'DEPUIS' },
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
  // THE SECOND DOOR (#204's UX rework vol. 2). Saving an account and signing into another
  // one were one button, one dress and one set of taps — and opposite acts. A returning
  // player was looking for a word that was not on screen, and had to infer that "save" also
  // meant "get it back" on the one screen where guessing wrong deletes something. It is a
  // QUIET door, never a second primary: most visitors to /account came to save.
  accountHaveAccount: { en: 'I ALREADY HAVE AN ACCOUNT', fr: "J'AI DÉJÀ UN COMPTE" },
  // The same door once THIS account is saved, where it means something milder: leaving is
  // reversible, because the account stays reachable by its own address.
  accountSwitch: { en: 'SIGN IN TO ANOTHER ACCOUNT', fr: 'SE CONNECTER À UN AUTRE COMPTE' },
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
    en: "Today's game and your friends come with you. The rest is lost.",
    fr: 'La partie du jour et vos amis vous suivent. Le reste est perdu.',
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
  // STREAK is untranslated vocabulary here, the family MISS and the rarity grades belong to.
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
  // The run's end, said ON THE CLOCK in place of its dead `0.0` (#175): the clock is what
  // ended the run, so it is the surface that says so. Uppercase like MISS — a statement
  // in the game's own pixel voice, not chrome.
  wordTimeUp: { en: 'TIME UP', fr: 'TEMPS ÉCOULÉ' },
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
  // A word run belongs to the DEVICE that started it (#217), and a device that does not
  // hold this day's run can only start it OVER. The gate says what that costs before the
  // tap. Another device is NAMED — two open tabs is enough to lose a live run by accident,
  // and the label is exactly what makes the loss legible. This device gets its own wording:
  // repeating its Mac / Chrome label as though it were elsewhere is accurate but confusing.
  // `{device}` is the table's second placeholder (see `tDevice`), for the reason `{n}` is
  // its first: the fragment is a name, and a name belongs inside its sentence rather than
  // concatenated onto one.
  wordRestartNote: {
    en: 'Started on {device}. Starting here ends that run.',
    fr: 'Commencé sur {device}. Recommencer ici met fin à cette partie.',
  },
  wordRestartHereNote: {
    en: 'A run was already started on this device. Starting over replaces it.',
    fr: 'Une partie a déjà commencé sur cet appareil. Recommencer la remplace.',
  },
  // …and the button says so, rather than wearing PLAY over new copy: the tap is a
  // deliberate act, so it takes a control of its own.
  gateRestart: { en: 'START OVER', fr: 'RECOMMENCER' },
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
  // ── WHICH PUZZLE (2026-08-30, user-decided) ────────────────────────────────────────
  // The header's left slot names the daily you are on, and one sheet behind it holds every
  // axis of "which puzzle am I playing": the language, the daily, and the day. They were
  // three separate controls in three places — a centred segmented switcher, a date chip and
  // a language chip — which is what left the row with no space and the account with no door.
  puzzleMenu: { en: 'Change puzzle', fr: 'Changer de puzzle' },
  // THE SAME SELECTION WITH ONE DRUM (2026-09-03): a screen that is not a puzzle has no
  // daily to name, so what hangs off its title is the LANGUAGE alone — and it says so, or a
  // reader who cannot see the screen is told they are about to change a puzzle that is not
  // there.
  langMenu: { en: 'Change language', fr: 'Changer de langue' },
  // The DAY row. It flips: from today it offers the calendar, from the calendar (or a past
  // day) it offers the way back to the live one.
  share: { en: 'SHARE', fr: 'PARTAGER' },
  copied: { en: 'COPIED', fr: 'COPIÉ' },
  // The INVITE toggle beside SHARE (user-decided 2026-09-05): positive, one word, the
  // player's own mark in the chip saying the rest. Never "don't share my profile".
  shareInvite: { en: 'INVITE', fr: 'INVITER' },
  shareInviteHint: {
    en: 'Add your invite to the link',
    fr: 'Ajouter votre invitation au lien',
  },
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
  ariaHome: { en: "Today's puzzle", fr: 'Puzzle du jour' },
  ariaHelp: { en: 'How to play', fr: 'Comment jouer' },
  // ---- archive calendar (#55): playable past days behind a calendar screen.
  archive: { en: 'ARCHIVE', fr: 'ARCHIVE' },
  ariaArchive: { en: 'Past puzzles', fr: 'Puzzles précédents' },
  ariaBackToToday: { en: "Back to today's puzzle", fr: 'Retour au puzzle du jour' },
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
  // The empty states, one per tab (user feedback 2026-08-20, replacing one long
  // "NO ONE ON THE BOARD YET" line): TERSE, under a small sad pixel ghost that carries
  // the mood. An empty friends tab really is "no friends" — friends who merely haven't
  // played today show as waiting rows — and the INVITE button below is the remedy.
  boardEmptyFriends: { en: 'NO FRIENDS', fr: "PAS D'AMIS" },
  boardEmptyGlobal: { en: 'NOBODY YET', fr: 'ENCORE PERSONNE' },
  boardEdit: { en: 'EDIT', fr: 'MODIFIER' },
  boardInvite: { en: 'INVITE FRIENDS', fr: 'INVITER DES AMIS' },
  // A friend on the board who has no recorded score today (user-decided 2026-08-20):
  // the row stays — an edge is a person you chose — and this label sits where their
  // score would.
  boardPlaying: { en: 'IN PROGRESS', fr: 'EN COURS' },
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
  // The landing's one primary button (#216 trigger rework): accepting is a TAP, never a
  // page load — the tap deploys the clicker's account if they have none, then records the
  // mutual edge.
  inviteAccept: { en: 'ADD FRIEND', fr: 'AJOUTER EN AMI' },
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

// The other placeholder: a DEVICE named inside its own sentence (#217 — "Started on
// iPhone / Chrome."). The label is a name, so it takes a placeholder rather than being
// concatenated onto a fragment — the two languages are free to put it where they want it.
export function tDevice(lang: string, key: UiKey, device: string): string {
  return t(lang, key).replace('{device}', device);
}

// Restarting always replaces a server-held Word run, but the owner changes how that cost
// should be said: name a genuinely different device; call the device in hand "this device".
export function wordRestartNote(lang: string, device: string, sameDevice: boolean): string {
  return sameDevice
    ? t(lang, 'wordRestartHereNote')
    : tDevice(lang, 'wordRestartNote', device);
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

// The route drawings are decorative (aria-hidden); these carry them in words.
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
