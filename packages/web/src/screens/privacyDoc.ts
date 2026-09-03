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
// read by a fourteen-year-old, in the register the account area already speaks (`vous`).
// Nothing here is a term of art: "a scrambled version of your IP address" is an HMAC, said
// in words a player can picture.
//
// **AND IT READS LIKE A PERSON WROTE IT (user-decided 2026-09-03).** The first draft had the
// tells of generated prose: dashes doing the work of sentences, aphorisms in threes,
// "it is there for one thing", "nobody else". The user's brief: no weird sentences, no
// jargon, no dashes, the way the person behind the game would actually explain it. So
// ordinary sentences, ordinary punctuation, "we" where a person would say we, and nothing
// written to sound good rather than to be understood.
//
// **IT DESCRIBES THE CODE, and the code is ground truth.** Every claim below is checked
// against something: the account row's stored address (`backend/linkStore.ts`), the device
// item's hashed token and coarse user-agent (#216), the round rows' folded guesses (#201),
// the HMAC-of-IP dedup and its 48h TTL (`SCORE_DEDUP_TTL_SECONDS`), the 10-minute code
// (`LINK_CODE_TTL_SECONDS`), the inbound-mail buffer and its 30 days (#230,
// `infra/lib/mail.ts` `INBOUND_RETENTION_DAYS`), the us-east-1 stacks (`infra/bin/app.ts`), Turnstile
// (`turnstile.ts`) and Plausible's three events (`analytics.ts`). A change to any of those is
// a change to this file. Two values here are NOT in the code and are read off the world
// instead — the host's legal entity and the mailbox provider, both below.

type UiLang = 'en' | 'fr';

// WHERE TO WRITE. The SES sender is derived in infra as `hello@<domain>`
// (`infra/lib/backend-stack.ts`), so the address a player is told to write to is the one the
// game already writes FROM — a reply lands in the same inbox as a question about a code.
export const PRIVACY_CONTACT = 'hello@whippin.ai';

// The ONE value on this page nobody can derive from the code — CONFIRMED 2026-09-03.
//
// WHO PUBLISHES THE SITE, said the way French law lets a private individual say it. The
// LCEN (art. 6-III-2) asks a website to identify its publisher, and gives a NON-PROFESSIONAL
// one this route: keep your own identity with the HOST, and publish the HOST's name and
// address instead. Whippin is free, carries no advertising and sells nothing, so it takes
// that route — the day it earns money, it stops qualifying and the publisher's own details
// have to appear here.
//
// It shipped as a GUESS at first — AWS's published EMEA entity, which is the usual one for a
// French account but not something the code can know. It is READ OFF THE BILLING MAIL now
// (the August 2026 statement, 2026-09-03), whose footer states it outright: "This message was
// produced and distributed by Amazon Web Services EMEA SARL, 38 avenue John F. Kennedy,
// L-1855 Luxembourg." Same string, now a fact.
//
// It is a legal identification, so a plausible guess is worse than none: if the account ever
// contracts with another AWS entity, this line is read off the invoice again, never adjusted
// from memory.
export const PRIVACY_HOST = 'Amazon Web Services EMEA SARL, 38 avenue John F. Kennedy, L-1855 Luxembourg';

// WHERE A MESSAGE TO US ENDS UP. Mail to `hello@` is forwarded (#230) to the operator's own
// inbox — `OPERATOR_EMAIL`, a CI variable, so the code cannot know who hosts it — and that
// provider receives and stores the whole message, which makes it a recipient this page has
// to name beside AWS, Cloudflare and Plausible. The name is read off the address CI is
// configured with; the day that inbox moves, this line moves with it.
export const PRIVACY_MAILBOX_PROVIDER = 'Google';

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
    title: 'What Whippin keeps about you, and why',
    lead: 'Whippin stores very little, but it does store a few things. This page lists all of them, explains what they are for, and tells you how to delete them.',
    sections: [
      {
        heading: 'WHAT IS KEPT',
        entries: [
          {
            term: 'Your email address',
            body: 'Only if you decide to save your account. We use it for one purpose: sending you a 6-digit code so you can get your account back on a new phone. We never share it or sell it, and we will not send you newsletters or ads.',
          },
          {
            term: 'An account number, and one key per device',
            body: 'When you start playing, the server gives your account a random number. Each browser you play from also keeps its own random key. Together, that is how the game knows a round is yours, without a password or a username. Every device also gets a rough label (like "iPhone / Chrome") and the date it was last used, so you can recognise it on your account page and sign it out if you need to.',
          },
          {
            term: 'Your games',
            body: 'The words you type in each round, your scores, the days you solved, the friends you added, and the name and avatar you picked. Basically your history, your streak and the leaderboards.',
          },
          {
            term: 'A scrambled version of your IP address',
            body: 'Your IP address is scrambled as soon as it reaches the server, in a way that cannot be reversed. We only use it to stop a single machine from flooding the game with scores, or from sending too many codes to one inbox. These traces are deleted automatically and are never kept for more than two days.',
          },
          {
            term: 'Anything you write to us',
            body: 'If you email {mail}, we receive your message and the address it came from, like any inbox. On its way there it passes through our server, which holds it for about 30 days and then deletes it automatically. The copy that reached our inbox stays until we no longer need it, or until you ask us to delete it.',
          },
        ],
      },
      {
        heading: 'WHAT STAYS IN YOUR BROWSER',
        paragraphs: [
          'Your device key and any guesses waiting to be sent are stored in your own browser. Whippin itself does not use cookies.',
          'If you clear your browsing data, they disappear, including the key that connects this device to your account. If you want to be able to get your account back afterwards, save it with an email address first.',
        ],
      },
      {
        heading: 'HOW LONG',
        paragraphs: [
          'Everything listed above is kept for as long as your account exists. A 6-digit code expires after 10 minutes. The scrambled IP traces are deleted within two days. A message you send us passes through our server for about 30 days on its way to the inbox.',
        ],
      },
      {
        heading: 'DELETING IT',
        paragraphs: [
          'If you sign in to another account from this device, the account you leave behind is deleted, unless it has its own email address. The screen tells you what will be deleted before you confirm.',
          'There is no button yet to delete everything else. Just write to {mail} and we will take care of it.',
        ],
      },
      {
        heading: 'WHO ELSE SEES IT',
        entries: [
          {
            term: 'Amazon Web Services',
            body: 'Hosts the game, its database and its files, and sends the code emails. Everything listed above is stored on their servers, which are in the United States. That transfer is covered by their EU-US Data Privacy Framework certification and by the standard contractual clauses in their data protection terms.',
          },
          {
            term: 'Cloudflare',
            body: 'Runs the invisible "are you a robot?" check when an account or a round is created. Cloudflare sees your IP address and some basic information about your browser, and may leave a cookie of its own for that check. It never sees your games.',
          },
          {
            term: 'Plausible',
            body: 'Counts visits and three simple events (a puzzle solved, a result shared, the tutorial opened). No cookies, and nothing that can be traced back to you.',
          },
          {
            term: PRIVACY_MAILBOX_PROVIDER,
            body: `Hosts the inbox that messages sent to {mail} are forwarded to. If you write to us, your message, your address and anything you attach end up in a mailbox run by ${PRIVACY_MAILBOX_PROVIDER}, under its own terms, for as long as we keep the message. Nothing else about you goes there.`,
          },
        ],
        outro: 'That is it. We do not sell anything about you, and there are no ads.',
      },
      {
        heading: 'ASKING',
        paragraphs: [
          'You can write to {mail} to ask what we keep about you, get a copy of it, have something corrected, or have all of it deleted.',
          'If you are not happy with the answer, you can file a complaint with the CNIL, the French data protection authority.',
        ],
      },
      {
        heading: 'WHO PUBLISHES THIS',
        paragraphs: [
          'Whippin is published by a private individual. As French law allows for a free, non-commercial site, the publisher\'s identity has been given to the host rather than shown here.',
          'Host: {host}.',
        ],
      },
    ],
    updatedLabel: 'Last updated',
  },
  fr: {
    title: 'Ce que Whippin garde sur vous, et pourquoi',
    lead: "Whippin stocke très peu de choses, mais il en stocke quand même quelques-unes. Cette page les liste toutes, explique à quoi elles servent, et vous dit comment les supprimer.",
    sections: [
      {
        heading: "CE QU'ON GARDE",
        entries: [
          {
            term: 'Votre adresse e-mail',
            body: "Seulement si vous choisissez de sauvegarder votre compte. Elle sert à une seule chose : vous envoyer un code à 6 chiffres pour retrouver votre compte sur un nouveau téléphone. On ne la partage pas, on ne la vend pas, et on ne vous enverra ni newsletter ni pub.",
          },
          {
            term: 'Un numéro de compte, et une clé par appareil',
            body: "Quand vous commencez à jouer, le serveur attribue un numéro aléatoire à votre compte. Chaque navigateur depuis lequel vous jouez garde aussi sa propre clé aléatoire. C'est comme ça que le jeu sait qu'une partie est la vôtre, sans mot de passe ni identifiant. Chaque appareil reçoit aussi une étiquette approximative (par exemple « iPhone / Chrome ») et la date de sa dernière utilisation, pour que vous puissiez le reconnaître sur la page de votre compte et le déconnecter si besoin.",
          },
          {
            term: 'Vos parties',
            body: "Les mots que vous tapez à chaque partie, vos scores, les jours résolus, les amis que vous avez ajoutés, et le nom et l'avatar que vous avez choisis. En gros, votre historique, votre série et les classements.",
          },
          {
            term: 'Une version brouillée de votre adresse IP',
            body: "Votre adresse IP est brouillée dès qu'elle arrive sur le serveur, d'une façon impossible à inverser. On s'en sert uniquement pour empêcher une même machine d'inonder le jeu de scores, ou d'envoyer trop de codes vers une même boîte mail. Ces traces sont supprimées automatiquement et ne sont jamais gardées plus de deux jours.",
          },
          {
            term: "Ce que vous nous écrivez",
            body: "Si vous écrivez à {mail}, on reçoit votre message et l'adresse d'où il vient, comme n'importe quelle boîte mail. En chemin, il passe par notre serveur, qui le garde environ 30 jours puis le supprime automatiquement. La copie arrivée dans la boîte reste tant qu'on en a besoin, ou jusqu'à ce que vous nous demandiez de la supprimer.",
          },
        ],
      },
      {
        heading: 'CE QUI RESTE DANS VOTRE NAVIGATEUR',
        paragraphs: [
          "La clé de votre appareil et les propositions en attente d'envoi sont stockées dans votre navigateur. Whippin lui-même n'utilise pas de cookies.",
          "Si vous effacez vos données de navigation, elles disparaissent, y compris la clé qui relie cet appareil à votre compte. Si vous voulez pouvoir retrouver votre compte ensuite, sauvegardez-le d'abord avec une adresse e-mail.",
        ],
      },
      {
        heading: 'COMBIEN DE TEMPS',
        paragraphs: [
          "Tout ce qui est listé ci-dessus est gardé tant que votre compte existe. Un code à 6 chiffres expire au bout de 10 minutes. Les traces d'adresse IP brouillées sont supprimées sous deux jours. Un message que vous nous envoyez passe environ 30 jours par notre serveur avant d'arriver dans la boîte.",
        ],
      },
      {
        heading: 'TOUT EFFACER',
        paragraphs: [
          "Si vous vous connectez à un autre compte depuis cet appareil, le compte que vous quittez est supprimé, sauf s'il a sa propre adresse e-mail. L'écran vous indique ce qui va être supprimé avant que vous confirmiez.",
          "Il n'y a pas encore de bouton pour supprimer tout le reste. Écrivez simplement à {mail} et on s'en occupe.",
        ],
      },
      {
        heading: "QUI D'AUTRE Y A ACCÈS",
        entries: [
          {
            term: 'Amazon Web Services',
            body: "Héberge le jeu, sa base de données et ses fichiers, et envoie les e-mails de code. Tout ce qui est listé ci-dessus est stocké sur leurs serveurs, qui se trouvent aux États-Unis. Ce transfert est couvert par leur certification au EU-US Data Privacy Framework et par les clauses contractuelles types de leurs conditions de protection des données.",
          },
          {
            term: 'Cloudflare',
            body: "Effectue la vérification invisible « êtes-vous un robot ? » quand un compte ou une partie est créé. Cloudflare voit votre adresse IP et quelques informations de base sur votre navigateur, et peut y déposer un cookie pour cette vérification. Il ne voit jamais vos parties.",
          },
          {
            term: 'Plausible',
            body: "Compte les visites et trois événements simples (une grille résolue, un résultat partagé, le tutoriel ouvert). Pas de cookies, et rien qui permette de remonter jusqu'à vous.",
          },
          {
            term: PRIVACY_MAILBOX_PROVIDER,
            body: `Héberge la boîte mail vers laquelle les messages envoyés à {mail} sont transférés. Si vous nous écrivez, votre message, votre adresse et ce que vous y joignez arrivent dans une boîte gérée par ${PRIVACY_MAILBOX_PROVIDER}, selon ses propres conditions, tant qu'on garde le message. Rien d'autre vous concernant n'y va.`,
          },
        ],
        outro: "C'est tout. On ne vend rien qui vous concerne, et il n'y a pas de publicité.",
      },
      {
        heading: 'NOUS ÉCRIRE',
        paragraphs: [
          "Vous pouvez écrire à {mail} pour savoir ce qu'on garde sur vous, en obtenir une copie, faire corriger quelque chose, ou tout faire supprimer.",
          "Si la réponse ne vous convient pas, vous pouvez déposer une réclamation auprès de la CNIL.",
        ],
      },
      {
        heading: 'QUI ÉDITE CE SITE',
        paragraphs: [
          "Whippin est édité par un particulier. Comme la loi française le permet pour un site gratuit et non commercial, l'identité de l'éditeur a été communiquée à l'hébergeur plutôt qu'affichée ici.",
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
