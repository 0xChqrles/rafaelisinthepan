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
