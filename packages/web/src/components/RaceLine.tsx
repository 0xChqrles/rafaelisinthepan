// THE RACE LINE: while the player plays today's sentence, the members of their groups just
// around them — ONE line resting on the top edge of the bottom zone, over whatever the tray
// holds (the keyboard, or a mask's REVEAL), never in the header.
//
// Wordless, numbers only (the ARIA label says it in words): each member's MARK, then, for a
// member still playing, their % in the heat ramp's ink (the board's own playing-row dress)
// and their tries muted; a member who FINISHED wears the solved mark and their score in the
// solve's cobalt; one whose round ended unsolved wears `∞`. The player's own entry is their
// mark and their LIVE % — the one place the play screen prints the player's own percentage.
// No rank number: a position mid-round moves with every guess (#206), so the line is an
// ORDER (`game/race.ts`), and the names stay on the board — the whole line is the tap onto it.
//
// It is an OVERLAY, laid on the tray's top edge rather than in the column: its arrival (the
// first answer lands after the round is already on screen) and its leaving move nothing. The
// room it lies in is the play area's race band (index.css `.play-race`), held for the whole
// round on today's sentence, so it never lies over the prompt.
import type { CSSProperties } from 'react';
import { anonName, defaultAvatar, progressHeatColor } from '@whippin/shared';
import Avatar from './Avatar';
import InfinityGlyph from './InfinityGlyph';
import SolvedIcon from '../assets/icons/check.svg?react';
import { shownFace, useOwnFace } from './AccountFace';
import { shownPercent, type RaceEntry } from '../game/race';
import { ariaRaceLine, type RaceSpoken } from '../i18n';
import { pathForBoard } from '../langs';
import { navigate } from '../routing';
import { primaryPress, startOpening } from '../state/boardOpening';

// A mark at an INTEGER cell scale: 10 cells of 2px — the header face's own size.
const MARK = 20;

export default function RaceLine({
  lang,
  entries,
  retired,
}: {
  lang: string;
  // The window, left to right: below the player to above (`game/race.ts`).
  entries: readonly RaceEntry[];
  // The round is ending: the line goes out with the prompt and stays laid down, invisible.
  retired: boolean;
}) {
  const own = shownFace(useOwnFace());
  const spoken: RaceSpoken[] = entries.map((entry) => {
    const name = entry.name || anonName(entry.publicId);
    return entry.kind === 'done'
      ? { name, kind: 'done', score: entry.score }
      : { name, kind: entry.kind, percent: shownPercent(entry.progress), tries: entry.tries, me: entry.me };
  });
  return (
    <button
      type="button"
      className={`race-line${retired ? ' retired' : ''}`}
      aria-label={ariaRaceLine(lang, spoken)}
      aria-hidden={retired || undefined}
      disabled={retired}
      // The board's read starts on the press (state/boardOpening.ts).
      onPointerDown={(e) => {
        if (primaryPress(e)) startOpening(lang);
      }}
      onClick={() => {
        startOpening(lang);
        navigate(pathForBoard(lang));
      }}
    >
      {entries.map((entry) => {
        const me = entry.kind !== 'done' && entry.me;
        const face = me ? own : entry;
        return (
          <span key={entry.publicId} className={`race-entry ${entry.kind}${me ? ' me' : ''}`}>
            {face ? (
              <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={MARK} sharp />
            ) : (
              // The player's own face is still being read: its box, never a guessed mark.
              <span className="race-mark-box" />
            )}
            {entry.kind === 'done' ? (
              <span className="race-done">
                <SolvedIcon className="race-solved" aria-hidden="true" focusable="false" />
                {entry.score}
              </span>
            ) : entry.kind === 'over' ? (
              <InfinityGlyph className="race-inf" cell={1} />
            ) : (
              <>
                <span
                  className="race-pct"
                  style={{ '--race-heat': progressHeatColor(entry.progress) } as CSSProperties}
                >
                  {shownPercent(entry.progress)}%
                </span>
                {!me && <span className="race-tries">{entry.tries}</span>}
              </>
            )}
          </span>
        );
      })}
    </button>
  );
}
