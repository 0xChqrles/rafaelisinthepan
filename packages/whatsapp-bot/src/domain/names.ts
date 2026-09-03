// Names are PRESENTATION state (#236). The sender JID stays canonical; what the group SEES
// is the latest observed display name, unless the operator override map names that JID
// otherwise. Nothing fuzzy-merges "Gab", "Gabriel" and "Gab 🔥" — those are three snapshots
// of one JID and the JID already merges them.

import type { GroupConfig } from '../config/groupConfig';
import type { Declaration } from './declarations';

// A fallback for a sender whose client sent no pushName at all: the last four digits of the
// phone JID, or the bare LID — enough to tell two nameless rows apart, never a full number.
export function fallbackName(jid: string): string {
  const user = jid.split('@')[0] ?? jid;
  return `…${user.slice(-4)}`;
}

// A name lands in a podium line, a tool answer and a prompt, so it arrives on ONE line
// and at a length a name can plausibly be — a name carrying newlines can forge a turn
// boundary in either, and one carrying a paragraph is not a name at all. A snapshot is a
// push name, arbitrary text its owner chose; an override is the operator's, but the bound
// is ONE function applied to BOTH: the config parser refuses an override this would
// change (so the file says what the group sees), and `displayName` applies it regardless,
// so no source of a name reaches a line or a prompt around it.
export const NAME_MAX_CHARS = 40;

export function boundName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS).trim();
}

// A valid override is one the bound leaves alone — one rule, with no second spelling.
export function isBoundName(text: string): boolean {
  return text !== '' && boundName(text) === text;
}

export function displayName(group: GroupConfig, jid: string, snapshot: string): string {
  const name = boundName(group.names[jid] ?? snapshot);
  return name === '' ? fallbackName(jid) : name;
}

export function nameResolver(group: GroupConfig): (d: Declaration) => string {
  return (d) => displayName(group, d.sender, d.name);
}
