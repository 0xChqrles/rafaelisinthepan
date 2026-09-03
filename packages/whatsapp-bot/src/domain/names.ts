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

export function displayName(group: GroupConfig, jid: string, snapshot: string): string {
  const override = group.names[jid];
  if (override) return override;
  const trimmed = snapshot.trim();
  return trimmed === '' ? fallbackName(jid) : trimmed;
}

export function nameResolver(group: GroupConfig): (d: Declaration) => string {
  return (d) => displayName(group, d.sender, d.name);
}
