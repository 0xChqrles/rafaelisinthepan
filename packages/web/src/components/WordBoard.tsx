import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';
import type { WordBoardModel } from '../game/wordBoard';
import type { Rarity } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';
import { srWordRarities, srRouteStop, srWordBoardWord } from '../i18n';

// Word mode's POST-MORTEM (#156, moved off the live phase by #163) — since 2026-09-01 a
// plain GRID of the zone's words, the sentence game's words modal applied here
// (user-decided: "apply this new design to the solved word mode too"), REPLACING the one
// trunk of dq-spaced stations, the rail, the nodes, the torn edges and the MISSED shelf
// the board drew until then. The words stand in as many columns as the window holds at
// ONE type size (the column is as wide as the longest word needs), FARTHEST at the top
// and CLOSEST at the bottom — nearest the day's word, which stays pinned under the window
// as the board's footer (`WordFoot`), where it stood through the whole run. Each word
// wears its RARITY grade's colour (what the claim paid, #163), its exponent the shared
// heat; a word the player CLAIMED wears its grade's colour as a CHIP — the held word's
// inverted chip, in the grade's ink — so a claimed word reads as yours exactly as a found
// word does in the sentence modal; a word the run's end merely NAMED stands plain in its
// colour; a word still censored (before the reveal beat) is `???`, quiet.

// Press Start 2P advances exactly 1em per glyph, so a word's width is arithmetic: its
// glyphs at `WORD_PX`, plus the exponent (up to four digits at 0.55em, one pixel off) and
// a chip's overhang. The board's frame is the post-mortem window's (`.word-window.wb-open`,
// up to `FRAME_MAX_PX` on a wide screen — the words modal's own width — less the
// scroller's padded side), and less the app's side inset on a phone.
const WORD_PX = 15;
const WORD_MIN_PX = 9;
const RANK_PX = 4 * WORD_PX * 0.55 + 1;
const CHIP_PX = WORD_PX * 0.4;
const UNKNOWN = '???';
const FRAME_MAX_PX = 1100;
const frameWidth = () =>
  typeof window === 'undefined' ? 410 : Math.min(FRAME_MAX_PX, window.innerWidth - 48) - 20;

// The day's word as the grid's LAST row: it stood centred through the run, the reveal
// fills the space above it and the scroller opens parked at the bottom, so it stands
// where it stood — and scrolls with its words. Decorative — the board's sr mirror
// announces the word.
export function WordFoot({ word }: { word: string }) {
  return (
    <p className="word-foot" aria-hidden="true">
      {word}
    </p>
  );
}

export default function WordBoard({ model, lang }: { model: WordBoardModel; lang: string }) {
  const [width, setWidth] = useState(frameWidth);
  useEffect(() => {
    const onResize = () => setWidth(frameWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const longest = model.stations.reduce((max, s) => Math.max(max, (s.word ?? UNKNOWN).length), 1);
  const column = Math.min(width, longest * WORD_PX + RANK_PX + CHIP_PX);
  const sizeOf = (word: string) =>
    Math.max(WORD_MIN_PX, Math.min(WORD_PX, (width - RANK_PX - CHIP_PX) / Math.max(1, word.length)));

  // The field's population per GRADE and how much of it is claimed — what the sr mirror
  // states as a count (a few hundred items of "rank 87, hidden" would bury the words the
  // player knows). Counted off the stations themselves.
  const population = new Map<Rarity, number>();
  let claimedCount = 0;
  for (const s of model.stations) {
    if (s.claimed) claimedCount += 1;
    population.set(s.rarity, (population.get(s.rarity) ?? 0) + 1);
  }
  const perGrade = model.grades.map((grade) => ({ grade, count: population.get(grade) ?? 0 }));

  // Farthest first: the closest words end up at the bottom, next to the word they are
  // closest to.
  const rows = [...model.stations].reverse();

  return (
    <div className="wb">
      {/* The grid is decorative; the sr-only list below carries the same content. */}
      <ul
        className="wb-grid"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${column}px, 1fr))` }}
      >
        {rows.map((s) => {
          const label = s.word ?? UNKNOWN;
          return (
            <li
              key={s.rank}
              className={`wb-word${s.claimed ? ' wb-claimed' : ''}${s.word === null ? ' wb-unknown' : ''}`}
              style={
                {
                  fontSize: `${sizeOf(label)}px`,
                  '--rarity-c': RARITY_COLORS[s.rarity],
                  '--rank-color': rankHeatColor(s.rank),
                } as CSSProperties
              }
            >
              <span className="wb-text">{label}</span>
              <sup className="wb-rank">{s.rank}</sup>
            </li>
          );
        })}
      </ul>

      {/* The board in words, closest first. Only what HAS a word is enumerated; the
          censored field is the count above it. */}
      <ol className="sr-only">
        <li>{srWordBoardWord(lang, model.word)}</li>
        <li>{srWordRarities(lang, perGrade, claimedCount)}</li>
        {model.stations
          .filter((s) => s.word !== null)
          .map((s) => (
            <li key={s.rank}>
              {/* The grade is what the word's colour says to everyone else, so a named
                  word says it here — the sr mirror's whole job on this board. */}
              {srRouteStop(lang, { rank: s.rank, word: s.word, rarity: s.rarity })}
            </li>
          ))}
      </ol>
    </div>
  );
}
