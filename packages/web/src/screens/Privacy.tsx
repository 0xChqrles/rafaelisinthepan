// THE PRIVACY NOTICE (#229): what the game keeps about a player, why, and how to be rid of
// it. `/privacy`, reached from `/account` and from the email flow's address field — the two
// screens where somebody is deciding whether to hand over an address.
//
// **IT IS A DOCUMENT, AND IT IS THE APP'S ONE WORDY SCREEN.** Every other surface here says
// only what it cannot show (the show-don't-tell rule); a legal notice has nothing to show, so
// it is allowed to be plainer and longer than anything else — and is still held to being
// readable by a fourteen-year-old. The words themselves live in `privacyDoc.ts`; what is
// here is how they are set.
//
// **SET LIKE AN ARTICLE** (user-decided 2026-09-03: "a bit more beautiful, like a blog
// post", and wider than the account column, which "on desktop feels like you're on a
// phone"): a TITLE in sentence case — the document's own first line, the claim the page
// substantiates — a DATELINE under it, a STANDFIRST, then sections each opened by a
// hairline. The area's three roles still tell the parts apart (2026-08-29): a section
// HEADING is chrome (uppercase, tracked, `--fg`), a TERM is the thing being named — on its
// own line, in a definition list, so a section skims like a run of small subheads — and the
// BODY is explanation (`--muted`, sentence case, regular).
//
// It is a STEP, not a place: the header's row lights the FACE (the whole account area is one
// place, its steps included) and the left slot carries the back control. Back is `goBack` and
// not a fixed parent, because this screen genuinely has two doors and dropping a player who
// was three taps into saving their account back at `/account` would cost them the flow.

import type { ReactNode } from 'react';
import LangTitle from '../components/LangTitle';
import { HeaderBack, HeaderLeft } from '../components/TopBar';
import useUiLang from '../hooks/useUiLang';
import { t } from '../i18n';
import { ACCOUNT_PATH } from '../langs';
import { goBack } from '../routing';
import { useGameStore } from '../state/gameStore';
import { PRIVACY_CONTACT, PRIVACY_HOST, PRIVACY_UPDATED, privacyDoc } from './privacyDoc';

// THE TWO VALUES THAT ARE NOT PROSE, dropped into whichever sentences name them — each
// stated ONCE in `privacyDoc.ts`, so the two languages cannot name two inboxes or two hosts.
//
// The address is a real `mailto:`, because "write to us" is the one instruction on this page
// a reader is meant to ACT on, and a phone cannot tap a paragraph. It is the app's only link
// out; every other control here is a button, so it wears the ACTION ink rather than a
// browser blue. The HOST is a legal identification and not a destination, so it is plain
// emphasised text — a name to read, never somewhere to go.
function fill(text: string): ReactNode {
  return text.split(/(\{mail\}|\{host\})/).map((part, i) => {
    if (part === '{mail}') {
      return (
        <a key={i} className="privacy-mail" href={`mailto:${PRIVACY_CONTACT}`}>
          {PRIVACY_CONTACT}
        </a>
      );
    }
    if (part === '{host}') {
      return (
        <span key={i} className="privacy-strong">
          {PRIVACY_HOST}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// The date the notice last became true, in the reader's own locale. Read as UTC: the value is
// a plain day, and a browser west of Greenwich would otherwise print the one before it.
function updatedOn(lang: string): string | null {
  const at = Date.parse(PRIVACY_UPDATED);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat(lang, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(at));
}

export default function Privacy() {
  // Global like the rest of the account area: an identity is not language-scoped, so the
  // chrome language is the `/` redirect's own resolution.
  const lang = useUiLang();
  const doc = privacyDoc(lang);
  const title = t(lang, 'privacyTitle');
  const updated = updatedOn(lang);

  return (
    <>
      <HeaderLeft>
        <HeaderBack label={t(lang, 'ariaBack')} onBack={() => goBack(ACCOUNT_PATH)} />
        <LangTitle lang={lang} title={title} />
      </HeaderLeft>
      <article className="privacy-screen">
        {/* THE HEAD: the document's title is its own first sentence — the header's chip
            names the SCREEN, this names the CLAIM — with the dateline where an article
            keeps one, and the standfirst under both. */}
        <header className="privacy-head">
          <h1 className="privacy-title">{doc.title}</h1>
          {updated && (
            <p className="privacy-dateline">{`${doc.updatedLabel} ${updated}`}</p>
          )}
          <p className="privacy-lead">{doc.lead}</p>
        </header>
        {doc.sections.map((section) => (
          <section key={section.heading} className="privacy-section">
            <h2 className="privacy-heading">{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph} className="privacy-text">
                {fill(paragraph)}
              </p>
            ))}
            {section.entries && (
              <dl className="privacy-list">
                {section.entries.map((entry) => (
                  <div key={entry.term}>
                    <dt className="privacy-term">{entry.term}</dt>
                    <dd className="privacy-text">{fill(entry.body)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {section.outro && <p className="privacy-text">{section.outro}</p>}
          </section>
        ))}
      </article>
    </>
  );
}
