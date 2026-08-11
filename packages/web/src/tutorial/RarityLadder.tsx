import type { CSSProperties } from 'react';
import { RARITY_NAMES, type Rarity } from '../game/wordGame';
import { RARITY_COLORS } from '../components/rarity';
import { t, type UiKey } from '../i18n';

// The tutorial's ending display (2026-08-11, replacing the themes clouds/routes teaser):
// the game's five rarity grades as a LADDER, commonest at the top, each name in the exact
// colour it wears everywhere else — the Word board's lanes, the strike, the loot. The names
// are the game's own untranslated vocabulary (COMMON..ARCANE, like MISS / YOU / DNF);
// beside each, an OBVIOUS example word (user-decided 2026-08-11) — the ladder teaches by
// evidence, house down to apricity — hand-authored per language in i18n.
//
// The rungs step DOWN in the pixel font at five static sizes — rarer is bigger (static
// sizes, never an animated scale: the pixel font renders animated scaling blurry, the
// app's standing rule). Each rung rises in on its own delay so the ladder reads
// top-to-bottom the way it is meant to be read; reduced motion collapses the durations via
// the global rule and keeps the delays, exactly like the floating numbers.
const EXAMPLE_KEYS: Record<Rarity, UiKey> = {
  COMMON: 'tutRarityExCommon',
  UNCOMMON: 'tutRarityExUncommon',
  RARE: 'tutRarityExRare',
  OBSCURE: 'tutRarityExObscure',
  ARCANE: 'tutRarityExArcane',
};

export default function RarityLadder({ lang }: { lang: string }) {
  return (
    <div
      className="rarity-ladder"
      role="img"
      aria-label={`${t(lang, 'srRarityLadder')} ${RARITY_NAMES.map(
        (grade) => `${grade} (${t(lang, EXAMPLE_KEYS[grade])})`,
      ).join(', ')}`}
    >
      {RARITY_NAMES.map((grade, step) => (
        <span
          key={grade}
          className="rarity-rung"
          style={{ '--step': step, color: RARITY_COLORS[grade] } as CSSProperties}
        >
          <b className="rarity-name">{grade}</b>
          <i className="rarity-example">{t(lang, EXAMPLE_KEYS[grade])}</i>
        </span>
      ))}
    </div>
  );
}
