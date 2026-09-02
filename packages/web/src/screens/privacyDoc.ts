// WHAT THE GAME KEEPS ABOUT A PLAYER (#229) — the document itself, apart from the screen
// that draws it.
//
// It lives beside the screen rather than in `i18n.ts` for the reason the tutorial's scripts
// do: that table is UI CHROME — buttons, statuses, aria labels, one line at a time — and this
// is a DOCUMENT, twenty paragraphs whose structure is part of what it says. Parity is still
// enforced by the compiler (`Record<UiLang, PrivacyDoc>`), which is the property that table
// exists for.
//
// **THE COPY RULE IS THE AREA'S, WITH ONE EXEMPTION.** The app says only what the screen does
// not already show; a legal notice has nothing to show, so it may be plainer and wordier than
// anything else here. What it may NOT be is legal boilerplate: every line is written to be
// read by a fourteen-year-old, in the app's own voice, in the register the account area
// already speaks (`vous`). Nothing here is a term of art — "a scrambled trace of your internet
// address" is an HMAC, said in words a player can picture.
//
// **IT DESCRIBES THE CODE, and the code is ground truth.** Every claim below is checked
// against something: the account row's stored address (`backend/linkStore.ts`), the device
// item's hashed token and coarse user-agent (#216), the round rows' folded guesses (#201),
// the HMAC-of-IP dedup and its 48h TTL (`SCORE_DEDUP_TTL_SECONDS`), the 10-minute code
// (`LINK_CODE_TTL_SECONDS`), the us-east-1 stacks (`infra/bin/app.ts`), Turnstile
// (`turnstile.ts`) and Plausible's three events (`analytics.ts`). A change to any of those is
// a change to this file.

type UiLang = 'en' | 'fr';

// WHERE TO WRITE. The SES sender is derived in infra as `hello@<domain>`
// (`infra/lib/backend-stack.ts`), so the address a player is told to write to is the one the
// game already writes FROM — a reply lands in the same inbox as a question about a code.
export const PRIVACY_CONTACT = 'hello@whippin.ai';

// ⚠ FILL BEFORE LAUNCH — the ONE value on this page nobody can derive from the code.
//
// WHO PUBLISHES THE SITE, said the way French law lets a private individual say it. The
// LCEN (art. 6-III-2) asks a website to identify its publisher, and gives a NON-PROFESSIONAL
// one this route: keep your own identity with the HOST, and publish the HOST's name and
// address instead. Whippin is free, carries no advertising and sells nothing, so it takes
// that route — the day it earns money, it stops qualifying and the publisher's own details
// have to appear here.
//
// The value below is AWS's published EMEA contracting entity, and it is a PLACEHOLDER: the
// entity on YOUR account and its registered address must be read off your own AWS invoice
// before this ships. It is a legal identification, so a plausible guess is worse than none.
export const PRIVACY_HOST = 'Amazon Web Services EMEA SARL, 38 avenue John F. Kennedy, L-1855 Luxembourg';

// WHEN THIS WAS LAST TRUE. An ISO instant rather than a sentence per language: the two would
// drift, and a date reads differently in the two locales anyway (the screen formats it).
export const PRIVACY_UPDATED = '2026-09-03';

// A NAMED THING and what is true of it — the shape four of the six sections take, because the
// question this page answers is "what, and why" and a bare paragraph buries the "what".
interface Entry {
  term: string;
  body: string;
}

interface Section {
  heading: string;
  paragraphs?: string[];
  entries?: Entry[];
  // A line that closes a list — what is NOT on it. Only the third parties have one.
  outro?: string;
}

export interface PrivacyDoc {
  // The document's own first line — a sentence, set as a title (2026-09-03: "like a blog
  // post"). It is the claim the whole page substantiates.
  title: string;
  // The standfirst under it: what the page is going to do about that claim.
  lead: string;
  sections: Section[];
  updatedLabel: string;
}

// The TTLs are stated as an upper BOUND ("never more than two days") rather than as an
// instant: the score floor's row expires at 48h (`SCORE_DEDUP_TTL_SECONDS`) and the send
// allowance's inside the hour, and DynamoDB's TTL sweep is best-effort besides — so a
// promise of an exact moment is one the store does not make.
//
// `{mail}` and `{host}` are filled by the screen from PRIVACY_CONTACT / PRIVACY_HOST, so the two languages cannot name two
// different inboxes — the `{n}` rule the Word gate's own copy follows.
export const PRIVACY: Record<UiLang, PrivacyDoc> = {
  en: {
    title: 'Whippin keeps as little about you as it can.',
    lead: 'Here is all of it, why it is kept, and how to get rid of it.',
    sections: [
      {
        heading: 'WHAT IS KEPT',
        entries: [
          {
            term: 'Your email address',
            body: 'Only if you save your account. It is there for one thing: giving your account back to you on a new phone. The only message ever sent to it is a 6-digit code. It is never shared, never sold, and it will never be used to advertise anything.',
          },
          {
            term: 'An account number, and one key per device',
            body: 'The server gives your account a random number, and every browser you play on keeps a random key of its own. Together they are how the game knows a round is yours — no password, no real name, nothing to remember. Each device also carries a rough label ("iPhone / Chrome") and the day it was last used, so you can recognise it on your account screen and sign it out.',
          },
          {
            term: 'Your games',
            body: 'The words you type in a round, your scores, the days you solved, the friends you added, and the name and drawing you picked. That is the game itself: your history, your streak, the boards.',
          },
          {
            term: 'A scrambled trace of your internet address',
            body: 'Scrambled the moment it arrives, into something nobody can turn back into an address. It is only used to stop one machine flooding the game with scores, or an inbox with codes. It is erased on its own, and never kept more than two days.',
          },
        ],
      },
      {
        heading: 'WHAT STAYS IN YOUR BROWSER',
        paragraphs: [
          'Your device key, and the guesses still waiting to be sent, live in your own browser. The game sets no cookies.',
          'Clearing your browsing data removes them — and the key with them, which is how this device reaches your account. Save your account with an email address first if you want to be able to get it back.',
        ],
      },
      {
        heading: 'HOW LONG',
        paragraphs: [
          'Everything above is kept while your account exists. A 6-digit code stops working after 10 minutes. The scrambled address traces are never kept more than two days.',
        ],
      },
      {
        heading: 'DELETING IT',
        paragraphs: [
          'Signing in to another account from this device deletes the account it leaves, unless that one has an email address of its own. The screen says exactly what is about to go before you agree to it.',
          'There is no button yet for deleting everything else. Ask, and it is done: write to {mail}.',
        ],
      },
      {
        heading: 'WHO ELSE SEES IT',
        entries: [
          {
            term: 'Amazon Web Services',
            body: 'Hosts the game, its database and its files, and sends the code emails. Everything above sits on their machines, on servers in the United States — a transfer covered by their own EU–US Data Privacy Framework certification and by the standard contractual clauses in their data protection terms.',
          },
          {
            term: 'Cloudflare',
            body: 'Runs the invisible "are you a robot?" check when an account or a round is created. It sees your internet address and a little about your browser. It never sees your games.',
          },
          {
            term: 'Plausible',
            body: 'Counts visits and three plain events — a puzzle solved, a result shared, the tutorial opened. No cookies, and nothing that points back at you.',
          },
        ],
        outro: 'Nobody else. Nothing about you is sold, and there is no advertising here.',
      },
      {
        heading: 'ASKING',
        paragraphs: [
          'Write to {mail} to know what is kept about you, to get a copy of it, to have something corrected, or to have all of it deleted.',
          'If the answer does not satisfy you, you can complain to the CNIL, the French data protection authority.',
        ],
      },
      {
        heading: 'WHO PUBLISHES THIS',
        paragraphs: [
          'Whippin is published by a private individual, who has given their identity to the host below — the route French law leaves open to a site that is free and sells nothing.',
          'Host: {host}.',
        ],
      },
    ],
    updatedLabel: 'Last updated',
  },
  fr: {
    title: 'Whippin garde le moins de choses possible sur vous.',
    lead: "Voici tout ce qu'il garde, pourquoi, et comment tout effacer.",
    sections: [
      {
        heading: "CE QU'ON GARDE",
        entries: [
          {
            term: 'Votre adresse e-mail',
            body: "Seulement si vous sauvegardez votre compte. Elle sert à une chose : vous rendre votre compte sur un nouveau téléphone. Le seul message qu'elle reçoit est un code à 6 chiffres. Elle n'est jamais partagée, jamais vendue, et ne servira jamais à vous vendre quoi que ce soit.",
          },
          {
            term: 'Un numéro de compte, et une clé par appareil',
            body: "Le serveur donne un numéro au hasard à votre compte, et chaque navigateur sur lequel vous jouez garde sa propre clé, au hasard elle aussi. À eux deux, c'est comme ça que le jeu sait qu'une partie est la vôtre : pas de mot de passe, pas de vrai nom, rien à retenir. Chaque appareil porte aussi une étiquette approximative (« iPhone / Chrome ») et le jour de sa dernière utilisation, pour que vous le reconnaissiez sur l'écran du compte et puissiez le déconnecter.",
          },
          {
            term: 'Vos parties',
            body: "Les mots que vous tapez, vos scores, les jours résolus, les amis ajoutés, le nom et le dessin que vous avez choisis. C'est le jeu lui-même : votre historique, votre série, les classements.",
          },
          {
            term: 'Une trace brouillée de votre adresse internet',
            body: "Brouillée dès son arrivée, en quelque chose que personne ne peut retransformer en adresse. Elle sert seulement à empêcher une machine d'inonder le jeu de scores, ou une boîte mail de codes. Elle s'efface toute seule, et n'est jamais gardée plus de deux jours.",
          },
        ],
      },
      {
        heading: 'CE QUI RESTE DANS VOTRE NAVIGATEUR',
        paragraphs: [
          "La clé de cet appareil, et les propositions en attente d'envoi, restent dans votre navigateur. Le jeu ne pose aucun cookie.",
          "Effacer les données de navigation les supprime — et la clé avec elles, alors que c'est par elle que cet appareil rejoint votre compte. Sauvegardez d'abord votre compte avec une adresse e-mail si vous voulez pouvoir le retrouver.",
        ],
      },
      {
        heading: 'COMBIEN DE TEMPS',
        paragraphs: [
          "Tout ce qui précède est gardé tant que le compte existe. Un code à 6 chiffres ne marche plus au bout de 10 minutes. Les traces brouillées d'adresse ne sont jamais gardées plus de deux jours.",
        ],
      },
      {
        heading: 'TOUT EFFACER',
        paragraphs: [
          "Se connecter à un autre compte depuis cet appareil supprime le compte qu'il quitte, sauf si celui-ci a sa propre adresse e-mail. L'écran dit exactement ce qui va disparaître avant que vous acceptiez.",
          "Pour le reste, il n'y a pas encore de bouton. Demandez, et c'est fait : écrivez à {mail}.",
        ],
      },
      {
        heading: "QUI D'AUTRE Y A ACCÈS",
        entries: [
          {
            term: 'Amazon Web Services',
            body: "Héberge le jeu, sa base de données et ses fichiers, et envoie les e-mails de code. Tout ce qui précède est stocké sur leurs machines, sur des serveurs situés aux États-Unis — un transfert couvert par leur propre certification au EU–US Data Privacy Framework et par les clauses contractuelles types de leurs conditions de protection des données.",
          },
          {
            term: 'Cloudflare',
            body: "Fait la vérification invisible « êtes-vous un robot ? » à la création d'un compte ou d'une partie. Il voit votre adresse internet et quelques informations sur votre navigateur. Il ne voit jamais vos parties.",
          },
          {
            term: 'Plausible',
            body: "Compte les visites et trois événements simples : une grille résolue, un résultat partagé, le tutoriel ouvert. Aucun cookie, et rien qui remonte jusqu'à vous.",
          },
        ],
        outro: "Personne d'autre. Rien de ce qui vous concerne n'est vendu, et il n'y a aucune publicité ici.",
      },
      {
        heading: 'NOUS ÉCRIRE',
        paragraphs: [
          "Écrivez à {mail} pour savoir ce qui est gardé sur vous, en obtenir une copie, faire corriger quelque chose, ou tout faire supprimer.",
          "Si la réponse ne vous convient pas, vous pouvez saisir la CNIL.",
        ],
      },
      {
        heading: 'QUI ÉDITE CE SITE',
        paragraphs: [
          "Whippin est édité par un particulier, dont l'identité a été communiquée à l'hébergeur ci-dessous — la voie que la loi française laisse ouverte à un site gratuit qui ne vend rien.",
          'Hébergeur : {host}.',
        ],
      },
    ],
    updatedLabel: 'Dernière mise à jour',
  },
};

export function privacyDoc(lang: string): PrivacyDoc {
  return PRIVACY[lang === 'fr' ? 'fr' : 'en'];
}
