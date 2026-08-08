import type { CSSProperties } from 'react';
import type { RankEntry } from '@whippin/shared';
import { rarityOf } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';

// The last few finds, stacked above the prompt like a chat (#163, decided 2026-08-09):
// newest at the bottom against the prompt, older ones riding up and fading out, and gone
// after that. Claims ONLY — a miss reports on the word and leaves no trace here, because
// this is the record of what the run has actually taken.
//
// It is where the RANK went. The float used to carry the exponent and now carries the grade
// (a timed run cannot act on a distance), but the number is still the thing a player wants
// a moment later — "how close was that one?" — and a log is where a moment later belongs.
// So each line is the word in its grade's colour with its exponent beside it: the two facts
// the float split between them, reunited once the guess is history.
const VISIBLE = 5;

// How faded the OLDEST visible line is. The newest sits at full strength and the rest ramp
// down to this, so age reads off the column without anything moving.
const FAINTEST = 0.22;

export default function WordHistory({
  claimed,
  corpusSize,
  retired = false,
}: {
  claimed: readonly RankEntry[];
  corpusSize: number;
  // The run is over. It stays MOUNTED — the footer's height is what keeps the word above it
  // still — but it has nothing left to say, and the result screen rises over this exact
  // space.
  retired?: boolean;
}) {
  const recent = claimed.slice(-VISIBLE);
  return (
    // Decorative throughout: every one of these was announced when it landed
    // (`srWordClaim`), and a reader does not need the same find twice.
    <div className={`word-history${retired ? ' retired' : ''}`} aria-hidden="true">
      {recent.map((entry, i) => (
        <span
          // The rank IS the group's identity (`wordGuessKey`), so it keys a line that must
          // mount exactly once — which is what keeps the entrance animation to the new line
          // instead of replaying the whole column on every guess.
          key={entry.rank}
          className="history-line"
          style={
            {
              color: RARITY_COLORS[rarityOf(entry.freq, corpusSize)],
              opacity: FAINTEST + ((1 - FAINTEST) * (i + 1)) / recent.length,
            } as CSSProperties
          }
        >
          {entry.word}
          <span className="history-rank">{`-${entry.rank}`}</span>
        </span>
      ))}
    </div>
  );
}
