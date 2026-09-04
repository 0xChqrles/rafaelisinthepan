// The RENDERER owns the podium message: positions, names, scores, punctuation, ordering
// and the group-language framing around it (#236). A model, when one is available, hands
// back one plain-text comment per line keyed by that line's id — nothing else of what is
// printed here comes from it, and a podium with no comments is a complete podium.

import { dateForDayNumber } from '@whippin/shared';
import type { GroupLanguage } from '../config/groupConfig';
import type { Podium, PodiumLine } from './podium';

export type Comments = ReadonlyMap<string, string>; // line id -> comment

// A line's id is its SCORE, as a string: stable across a re-render, unique per line by
// construction (one line per distinct score), and what the model's answer is keyed by.
export function lineId(line: PodiumLine): string {
  return String(line.score);
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

export function joinNames(names: readonly string[], language: GroupLanguage): string {
  if (names.length <= 1) return names[0] ?? '';
  const and = language === 'fr' ? ' et ' : ' and ';
  return `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]}`;
}

export function renderPodium(
  podium: Podium,
  language: GroupLanguage,
  comments: Comments = new Map(),
): string {
  const title =
    language === 'fr'
      ? `🏆 Podium Whippin du ${dayLabel(podium.dayNumber, language)}`
      : `🏆 Whippin podium, ${dayLabel(podium.dayNumber, language)}`;
  const out: string[] = [title, ''];
  for (const line of podium.lines) {
    const names = joinNames(
      line.players.map((p) => p.name),
      language,
    );
    out.push(`${line.position} — ${names} — ${line.score}`);
    const comment = comments.get(lineId(line));
    if (comment) out.push(`_${comment}_`);
  }
  if (podium.capped.length > 0) {
    out.push(
      `∞ — ${joinNames(
        podium.capped.map((p) => p.name),
        language,
      )}`,
    );
  }
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
// reads as a notification and not as a friend saying "c'est parti".
const KIND_FR: Record<string, string> = { music: 'une chanson', book: 'un livre', movie: 'un film', poem: 'un poème', quote: 'une citation' };
const KIND_EN: Record<string, string> = { music: 'a song', book: 'a book', movie: 'a film', poem: 'a poem', quote: 'a quote' };

export function renderReminder(
  language: GroupLanguage,
  siteOrigin: string,
  kind: string | null,
  podiumTime: string | null, // "HH:MM" in the group's own zone, or null when no podium
): string {
  const what = kind ? (language === 'fr' ? KIND_FR[kind] : KIND_EN[kind]) : undefined;
  const time = podiumTime ? (language === 'fr' ? podiumTime.replace(':', 'h') : podiumTime) : null;
  const head =
    language === 'fr'
      ? `Le Whippin du jour est en ligne${what ? `, c'est ${what} aujourd'hui` : ''}.${time ? ` Podium à ${time}.` : ''}`
      : `Today's Whippin is up${what ? `, it's ${what} today` : ''}.${time ? ` Podium at ${time}.` : ''}`;
  return `${head}\n${siteOrigin}`;
}
