import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BenchmarkResults } from '@whippin/shared';
import { lineupModel, lineupEvents } from '../game/benchmark';
import { t } from '../i18n';
import Crown from '../assets/crown.svg?react';

// Mid-game standings lineup (#81): the player and the three benchmark opponents standing
// side by side above the keyboard, sorted by tries ascending (best far left), name + score
// under each, and the crown floating above the leader. Purely derived UI: everything is a
// function of (guessCount, benchmark), so a reloaded round reconstructs it with no state.
//
// DOM order is stable (React keys move the same nodes on a reorder), and each slot's
// position is its sorted index driving a translateX — so a standings change is a slide
// exchange, not a remount. Decorative throughout (aria-hidden): the meaningful events are
// mirrored into the game's polite live region by Round.
export default function StandingsLineup({
  benchmark,
  guessCount,
  solved,
  lang,
}: {
  benchmark: BenchmarkResults;
  guessCount: number;
  solved: boolean;
  lang: string;
}) {
  const model = useMemo(
    () => lineupModel(benchmark, guessCount, t(lang, 'you')),
    [benchmark, guessCount, lang],
  );

  // The mid-game loss beat: when the crown leaves the player, hop it and shake the player
  // sprite (the game's existing hit vocabulary). Detected by diffing consecutive lineup
  // states; the counter keys the animated nodes so the animation replays on each beat
  // (the crown can only transfer once per round, but a dev-tools time traveler is safe).
  const prevModel = useRef(model);
  const [lossBeat, setLossBeat] = useState(0);
  useEffect(() => {
    const events = lineupEvents(prevModel.current, model);
    prevModel.current = model;
    if (events.lostLead) setLossBeat((n) => n + 1);
  }, [model]);

  return (
    <div className="lineup" aria-hidden="true">
      <div className="lineup-track">
        {/* The crown never moves: it floats above the LEFTMOST slot (first place) and the
            characters exchange beneath it. Grey (grayscale of the gold asset) during play,
            gold once the round ends — derived, so the two states can never drift. */}
        <span
          key={`crown-${lossBeat}`}
          className={`lineup-crown${solved ? ' gold' : ''}${lossBeat > 0 && !solved ? ' hop' : ''}`}
        >
          <Crown className="pixel-icon" aria-hidden />
        </span>
        {model.entrants.map((entrant, index) => (
          <div
            key={entrant.key}
            className="lineup-slot"
            style={{ '--i': index } as CSSProperties}
          >
            <span
              key={entrant.player ? `sprite-${lossBeat}` : 'sprite'}
              className={`lineup-sprite ${
                entrant.player ? 'lineup-sprite-player' : `lineup-sprite-${entrant.sprite}`
              }${entrant.player && lossBeat > 0 && !solved ? ' hit' : ''}`}
            />
            <span className={`lineup-tag${entrant.player ? ' player' : ''}`}>{entrant.tag}</span>
            <span className="lineup-score">{entrant.tries ?? t(lang, 'dnf')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
