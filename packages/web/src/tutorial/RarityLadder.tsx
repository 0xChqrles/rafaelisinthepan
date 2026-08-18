import type { CSSProperties } from 'react';
import { RARITY_NAMES, type Rarity } from '../game/wordGame';
import { RARITY_COLORS } from '../components/rarity';
import { t, type UiKey } from '../i18n';

// The tutorial's ending display (2026-08-11, replacing the themes clouds/routes teaser;
// REDESIGNED 2026-08-18 as a SIGNAL METER — the size-ramped two-font rungs read badly on
// user review): five rows, commonest first, each carrying a five-cell LED METER with one
// more cell lit per grade — rarity as signal strength, the member cards' own cell
// language — the grade's name as a small quiet mono label, and the OBVIOUS example word
// (user-decided 2026-08-11; hand-authored per language in i18n) in the pixel face at ONE
// size, wearing the grade's colour. The fonts stop competing because they keep their
// app-wide jobs: mono labels, pixel words.
//
// Each row rises in on its own delay so the ladder reads top-to-bottom; reduced motion
// collapses the durations via the global rule and keeps the delays, exactly like the
// floating numbers.
const EXAMPLE_KEYS: Record<Rarity, UiKey> = {
  COMMON: 'tutRarityExCommon',
  UNCOMMON: 'tutRarityExUncommon',
  RARE: 'tutRarityExRare',
  OBSCURE: 'tutRarityExObscure',
  ARCANE: 'tutRarityExArcane',
};

const METER_CELLS = 5;

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
          <span className="rarity-meter" aria-hidden="true">
            {Array.from({ length: METER_CELLS }, (_, i) => (
              // Static decorative cells: the index is the identity.
              // eslint-disable-next-line react/no-array-index-key
              <i key={i} className={i <= step ? 'on' : undefined} />
            ))}
          </span>
          <i className="rarity-example">{t(lang, EXAMPLE_KEYS[grade])}</i>
        </span>
      ))}
    </div>
  );
}
