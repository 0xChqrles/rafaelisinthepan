// The RENDERER owns the podium message: positions, names, scores, punctuation, ordering
// and the group-language framing around it (#236). A model, when one is available, hands
// back one plain-text comment per line keyed by that line's id — nothing else of what is
// printed here comes from it, and a podium with no comments is a complete podium.

import { dateForDayNumber } from '@whippin/shared';
import type { GroupLanguage } from '../config/groupConfig';
import type { OtherLanguage, Podium, PodiumPlayer } from './podium';

export type Comments = ReadonlyMap<string, string>; // line id -> comment

// ONE PRINTED LINE: a player, their place and their score — or ∞ for a run that never
// finished, printed after the places, its `position` the place after the last (which is
// where a reader counts it). Its id is its number in the printed order ("1", "2", …):
// unique by construction, stable across a re-render of the same podium, what the model's
// answer is keyed by, and never a JID (ids reach the logs).
export interface PodiumRow {
  id: string;
  position: number;
  score: number | '∞';
  player: PodiumPlayer;
}

export function podiumRows(podium: Podium): PodiumRow[] {
  const afterLast = (podium.lines.at(-1)?.position ?? 0) + 1;
  return [
    ...podium.lines.map((l) => ({ position: l.position, score: l.score as number | '∞', player: l.player })),
    ...podium.capped.map((player) => ({ position: afterLast, score: '∞' as const, player })),
  ].map((row, i) => ({ id: String(i + 1), ...row }));
}

const MONTHS_FR = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function dayLabel(dayNumber: number, language: GroupLanguage): string {
  const [y, m, d] = dateForDayNumber(dayNumber).split('-').map(Number);
  if (language === 'fr') return `${d === 1 ? '1er' : d} ${MONTHS_FR[m - 1]} ${y}`;
  return `${MONTHS_EN[m - 1]} ${d}, ${y}`;
}

// The other languages' results, closing the podium: "Côté anglais : Charles 7 · Marie 15".
const LANGUAGE_NAMES: Record<GroupLanguage, Record<string, string>> = {
  fr: { en: 'anglais', fr: 'français' },
  en: { en: 'English', fr: 'French' },
};

function renderOtherLanguage(other: OtherLanguage, language: GroupLanguage): string {
  const results = other.results.map((r) => `${r.name} ${r.score}`).join(' · ');
  const name = LANGUAGE_NAMES[language][other.lang] ?? other.lang;
  return language === 'fr' ? `Côté ${name} : ${results}` : `In ${name}: ${results}`;
}

export function renderPodium(
  podium: Podium,
  language: GroupLanguage,
  comments: Comments = new Map(),
  others: readonly OtherLanguage[] = [],
): string {
  const title =
    language === 'fr'
      ? `🏆 Podium Whippin du ${dayLabel(podium.dayNumber, language)}`
      : `🏆 Whippin podium, ${dayLabel(podium.dayNumber, language)}`;
  const out: string[] = [title, ''];
  for (const row of podiumRows(podium)) {
    out.push(row.score === '∞' ? `∞ — ${row.player.name}` : `${row.position} — ${row.player.name} — ${row.score}`);
    const comment = comments.get(row.id);
    if (comment) out.push(`_${comment}_`);
  }
  const closing = others.filter((o) => o.results.length > 0);
  if (closing.length > 0) out.push('', ...closing.map((o) => renderOtherLanguage(o, language)));
  return out.join('\n');
}

// The proactive new-leader line (domain/leader.ts) — deterministic wording, no model.
export function renderLeader(name: string, score: number, language: GroupLanguage): string {
  return language === 'fr'
    ? `${name} prend la tête avec ${score}.`
    : `${name} takes the lead with ${score}.`;
}

// THE MORNING LINE (user-decided 2026-09-05): one bubble saying the day's puzzle is up,
// what KIND of thing it is when the day's source says so (the one half of the source the
// bot may say — `puzzle/daySource.ts`), when the podium lands, and the link. Deterministic:
// a model has nothing to add at nine in the morning. One line, because anything longer
// reads as a notification and not as a friend saying "c'est parti" — and, when the group
// plays as a Whippin group (user-decided 2026-09-14), one more asking it to join, with the
// invite link the message's preview card belongs to.
const KIND_FR: Record<string, string> = { music: 'une chanson', book: 'un livre', movie: 'un film', poem: 'un poème', quote: 'une citation' };
const KIND_EN: Record<string, string> = { music: 'a song', book: 'a book', movie: 'a film', poem: 'a poem', quote: 'a quote' };

export function renderReminder(
  language: GroupLanguage,
  siteOrigin: string,
  kind: string | null,
  podiumTime: string | null, // "HH:MM" in the group's own zone, or null when no podium
  invite: string | null = null, // the Whippin group's invite link, only once it was read as standing
): string {
  const what = kind ? (language === 'fr' ? KIND_FR[kind] : KIND_EN[kind]) : undefined;
  const time = podiumTime ? (language === 'fr' ? podiumTime.replace(':', 'h') : podiumTime) : null;
  const head =
    language === 'fr'
      ? `Le Whippin du jour est en ligne${what ? `, c'est ${what} aujourd'hui` : ''}.${time ? ` Podium à ${time}.` : ''}`
      : `Today's Whippin is up${what ? `, it's ${what} today` : ''}.${time ? ` Podium at ${time}.` : ''}`;
  const lines = [head, siteOrigin];
  if (invite) lines.push(language === 'fr' ? `Rejoignez le groupe sur Whippin : ${invite}` : `Join the group on Whippin: ${invite}`);
  return lines.join('\n');
}
