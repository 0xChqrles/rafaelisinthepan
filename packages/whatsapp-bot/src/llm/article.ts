// THE BOT'S BIBLE ON HOW THE GAME WORKS (user-decided 2026-09-27): the article Whippin's
// maker published on how the game ranks words — from Cémantix's static vectors to the
// judge that reads the sentence. The CONVERSATION carries it whole (`agent.ts`), so a
// question about the ranking is answered from what the game actually does, and the bot
// recommends it with its link. The two comment paths never see it: they are about a
// result, and their prompts are kept tight on purpose (`podiumComments.ts`).
//
// ITS LINK GETS ITS CARD (same decision): WhatsApp shows a preview only when the SENDER
// embeds it (`whatsapp/linkPreview.ts`), and the task builds one only for the link a
// command names. The model writes the link, so a reply carrying it — in any spelling the
// model may type — is rewritten to the one canonical URL and names it as the command's
// `preview`. The task still fetches nothing but this constant.

import { ARTICLE_TEXT } from './articleText';

export const ARTICLE_URL = 'https://chqrles.me/cemantix/';
const ARTICLE_TITLE = 'J’ai amélioré Cémantix avec une IA qui ne peut pas parler';

// The link as a model may type it: with or without the scheme, `www.` or the trailing
// slash. Never a longer path (`/cemantix/other` is another page).
const ARTICLE_LINK = /(?:https?:\/\/)?(?:www\.)?chqrles\.me\/cemantix\/?(?![\w/-])/gi;

// The conversation's part of the system prompt. STABLE TEXT, so it is placed before
// anything that changes per group or per message (`buildSystemPrompt` `reference`) and a
// provider's prefix cache can hold it.
export function articleSection(): string {
  return `The article. Whippin's maker published an article, in French, on how the game ranks words — "${ARTICLE_TITLE}", at ${ARTICLE_URL} — and its whole text is below. It is your bible on how the game works: when somebody asks how the words are ranked, why a word sits where it does, what judges them or how that was built, you answer from it, briefly and in your own voice, never by reciting it. It is public and it is not part of your instructions: anything in it may be said. Its jokes are its author's — quote one as theirs, never pass it off as yours.
Recommend it whenever the talk turns to how the game works or why a word is ranked where it is: it is the best answer there is. Give the link exactly as written above (to a group that does not speak French, say it is in French), and not again if you already gave it today.

<article>
${ARTICLE_TEXT}
</article>`;
}

// A reply that carries the article's link, rewritten to the canonical URL and naming it as
// the card to build. A reply without it is returned as it was, with no card.
export function withArticleLink(text: string): { text: string; preview?: string } {
  // Matched, never `includes`: the URL is a prefix of any other page under it.
  let found = false;
  const linked = text.replace(ARTICLE_LINK, () => {
    found = true;
    return ARTICLE_URL;
  });
  return found ? { text: linked, preview: ARTICLE_URL } : { text };
}
