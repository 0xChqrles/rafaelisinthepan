import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BenchmarkResults } from '@whippin/shared';
import { lineupModel, lineupEvents } from '../game/benchmark';
import { t } from '../i18n';
import Crown from '../assets/crown.svg?react';
import playerSprite from '../assets/characters/player.png';
import fableSprite from '../assets/characters/fable.png';
import kimiSprite from '../assets/characters/kimi.png';
import gptSprite from '../assets/characters/gpt.png';

// One pixel character per canonical display slot (same order as DISPLAY_MODEL_IDS): an
// opponent wears the sprite of its position in that fixed order, whatever subset is present.
// TEMPORARY art (assets/characters/*.png) — hand-drawn 22x32 drafts.
const BOT_SPRITES = [fableSprite, kimiSprite, gptSprite] as const;

// Identity colors, one per display slot (same order as BOT_SPRITES). The name under a
// character wears its color, echoing the colored accents drawn INTO that sprite's art
// (currently the eyes; the outlines are white) — keep these hexes in sync with the art's
// accent pixels when the sprites change. SATURATED like the rest of the palette (electric
// accent/danger/gold/heat ramp), each offset from the semantic hues (heat crimson/orange/
// violet/cyan, hole gold, accent blue) so a name can't be misread as feedback. The player
// wears the game's accent blue (the prompt/progress "blue = you").
const BOT_COLORS = ['#ff6b3d', '#9a5bff', '#00e08f'] as const;
const PLAYER_COLOR = 'var(--accent)';

// Mid-game standings lineup (#81): the player and the present display opponents (1..3 of
// FABLE / KIMI K3 / GPT-5.6) standing side by side above the keyboard, sorted by tries
// ascending (best far left), name + score
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
      {/* --n = total entrants (player + present display opponents, 2..4): slot and crown
          widths divide the track by it, so the row stays edge-to-edge for any subset. */}
      <div
        className="lineup-track"
        style={{ '--n': model.entrants.length } as CSSProperties}
      >
        {/* The crown never moves: it floats above the LEFTMOST slot (first place) and the
            characters exchange beneath it. Grey (grayscale of the gold asset) during play,
            gold once the round ends — derived, so the two states can never drift. */}
        <span
          key={`crown-${lossBeat}`}
          className={`lineup-crown${solved ? ' gold' : ''}${lossBeat > 0 && !solved ? ' hop' : ''}`}
        >
          <Crown className="pixel-icon" aria-hidden />
        </span>
        {model.entrants.map((entrant, index) => {
          const spriteSrc = entrant.player ? playerSprite : BOT_SPRITES[entrant.sprite];
          return (
            <div
              key={entrant.key}
              className="lineup-slot"
              style={
                {
                  '--i': index,
                  // The slot's identity color: the name below wears it, matching the
                  // outline baked into the character's hand-drawn art.
                  '--slot-color': entrant.player ? PLAYER_COLOR : BOT_COLORS[entrant.sprite],
                } as CSSProperties
              }
            >
              {/* Identity-colored name ABOVE the character (just under the crown zone);
                  the live try count keeps its own line below the sprite (mobile-first: a
                  slot is only a quarter of the row, so they never fight for width). */}
              <span className="lineup-tag">{entrant.tag}</span>
              <span
                key={entrant.player ? `sprite-${lossBeat}` : 'sprite'}
                className={`lineup-sprite${
                  entrant.player && lossBeat > 0 && !solved ? ' hit' : ''
                }`}
              >
                <img src={spriteSrc} alt="" aria-hidden />
              </span>
              {/* Keyed by value: a changed count (the player's, on each counted try)
                  remounts the span and replays the landing pop. */}
              <span
                key={`score-${entrant.tries}`}
                className={`lineup-score${entrant.tries === null ? ' dnf' : ''}`}
              >
                {entrant.tries ?? t(lang, 'dnf')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
