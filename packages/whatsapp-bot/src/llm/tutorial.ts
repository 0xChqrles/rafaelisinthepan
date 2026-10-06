// THE TUTORIAL'S LEVELS, AS THE CONVERSATION KNOWS THEM (user-decided 2026-10-02): asked how
// the game works, the bot sends the level that explains it rather than explaining it itself.
// Which levels exist, in which languages, and where their pages are is the shared table the
// web teaches from (`shared/src/tutorial.ts`); what each one ANSWERS is said here, for the
// model to pick the right one. The share line, the podium and the diary never carry it.
//
// ITS LINKS GET THEIR CARD: WhatsApp shows a preview only when the SENDER embeds it
// (`whatsapp/linkPreview.ts`), and the task builds one only for the link a command names. The
// model writes the link, so a reply carrying one — in any spelling it may type — is rewritten
// to the canonical URL and the first one names the command's `preview`. Only a page the shared
// table says exists is rewritten, so the task fetches nothing the code did not build.

import { PLAY_LEVEL, TUTORIAL_LEVELS, isReady, learnPath, lessonPath, type TutorialLevel } from '@whippin/shared';
import { escapeRegExp } from '../domain/share';
import { languageName } from '../domain/shareContext';

// What each level answers, in the words a question would use. A level the shared table adds
// needs a line here (`tutorial.test.ts`).
export const LEVEL_ANSWERS: Record<number, string> = {
  1: 'the game, played: how to play, what a rank is, one guess landing on every hole, the score, the meter that unlocks hints',
  2: 'the distance: how the game measures how close two words are — every word turned into coordinates, learned from the way words are used across an enormous amount of text',
  3: 'many meanings: why that is not enough — one word holds all its senses in a single set of coordinates, so the sentence has to be read',
  4: 'attention: how a machine reads a sentence, each word looking at the others',
  5: 'the judge: how the game ranks the words for the day’s sentence — why a word sits where it does',
};

// A level's page in the group's language when it is written there, else in the first
// language it is.
function levelPage(siteOrigin: string, level: TutorialLevel, lang: string): { url: string; lang: string } {
  const written = isReady(level, lang) ? lang : Object.keys(level.duration)[0];
  return { url: `${siteOrigin}${lessonPath(written, level.level)}`, lang: written };
}

// The conversation's part of the system prompt: the same for every message of a group.
export function tutorialSection(siteOrigin: string, lang: string): string {
  const levels = TUTORIAL_LEVELS.map((level) => {
    const page = levelPage(siteOrigin, level, lang);
    const elsewhere = page.lang === lang ? '' : ` (in ${languageName(page.lang)})`;
    return `- Level ${level.level}, ${LEVEL_ANSWERS[level.level]}: ${page.url}${elsewhere}`;
  });
  return `The tutorial. The game is explained on its site, in levels — one page each, read in a few minutes:
${levels.join('\n')}
- All the levels on one page: ${siteOrigin}${learnPath(lang)}
When somebody asks how the game works — a rule, the score, the hints, why a word sits where it does, how the words are ranked or what judges them — your answer IS the link to the level that answers it, written exactly as above. Around it, a few words in your own voice and no explanation: you do not summarise the page, describe what is in it or say how it works yourself. The one exception is a question one fact answers (what a rank of 0 is, whether a miss counts): that fact in a few words, then the link. A question about the whole game, or about several things at once: the page of all the levels. One link per message.`;
}

// The tutorial's pages on the configured site, as a model may type them: with or without
// the scheme or `www.`, a trailing slash or not. Never a longer path.
function tutorialLink(siteOrigin: string): RegExp {
  const host = siteOrigin.replace(/^https?:\/\//, '');
  return new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?${escapeRegExp(host)}\\/([a-z]{2})\\/learn(?:\\/(\\d+))?\\/?(?![\\w/-])`, 'gi');
}

// The canonical URL of a page the shared table says exists, else null.
function canonical(siteOrigin: string, lang: string, level: string | undefined): string | null {
  const code = lang.toLowerCase();
  const play = TUTORIAL_LEVELS.find((l) => l.level === PLAY_LEVEL);
  if (!play || !isReady(play, code)) return null; // no tutorial in that language
  if (level === undefined) return `${siteOrigin}${learnPath(code)}`;
  const found = TUTORIAL_LEVELS.find((l) => l.level === Number(level));
  return found && isReady(found, code) ? `${siteOrigin}${lessonPath(code, found.level)}` : null;
}

// A reply with its tutorial links rewritten to their canonical URLs, the first naming the
// card to build. A reply with none is returned as it was, with no card.
export function withTutorialLink(text: string, siteOrigin: string): { text: string; preview?: string } {
  let preview: string | undefined;
  const linked = text.replace(tutorialLink(siteOrigin), (typed, lang: string, level: string | undefined) => {
    const url = canonical(siteOrigin, lang, level);
    if (!url) return typed;
    preview ??= url;
    return url;
  });
  return preview ? { text: linked, preview } : { text };
}
