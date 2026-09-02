import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { rankHeatColor } from '@whippin/shared';
import type { HistoryModel } from '../game/history';
import { holeTitle, srRouteStop } from '../i18n';
import ModalHeader from './ModalHeader';
import useModalDismiss from '../hooks/useModalDismiss';

// The WORDS modal (user-decided 2026-09-01): a COMPLETED hole — rank 0, whether or not the
// rest of the sentence is — opens this instead of the wheel, since there is nothing left
// to swap in. It is the old history modal's screen with the ROAD taken out: no rail, no
// nodes, no distances drawn — the found word as the headline, then every word found for
// it "like on a synonyms website": a plain grid, closest first, every word in `--fg` with
// its exponent in the shared heat colour — and the ones the player actually FOUND wearing
// the held word's own inverted CHIP (user-decided 2026-09-01, superseding a dim on the
// never-typed ones): the app's one emphasis gesture, so the list reads as the sentence
// does — a chipped word is one you typed. ONE type
// size for every word (user-decided 2026-09-01: "avoid reducing the font size, even if it
// leads to less columns"): the column is as wide as the LONGEST word needs, so a wide
// screen takes as many such columns as fit and a phone gets one or two; only a word that
// would not fit the whole width of a phone shrinks, alone. Read-only; the shared
// `ModalHeader` and Escape are the ways out, and it FOLDS with a fade like the wheel.

// Press Start 2P advances exactly 1em per glyph, so a word's width is arithmetic: its
// glyphs at `WORD_PX`, plus the exponent (up to four digits at 0.55em, one pixel off).
const WORD_PX = 15;
const WORD_MIN_PX = 9;
const RANK_PX = 4 * WORD_PX * 0.55 + 1;
// The chip's own overhang, both sides (the sentence chip's 0.2em), which a found word's
// column has to hold.
const CHIP_PX = WORD_PX * 0.4;
// The scroller's side padding, both sides — what a word must fit inside on a phone.
const SIDES_PX = 40;
const FRAME_MAX_PX = 1100;

export default function HistoryModal({
  model,
  number,
  lang,
  onClose,
}: {
  model: HistoryModel;
  // The hole's 1-based sentence position among distinct secrets — the ruler's numbering.
  number: number;
  lang: string;
  onClose: () => void;
}) {
  // FIRST hook on purpose: it owns `showModal()` and turns every dismissal into the fold.
  const { closing, beginClose, dialogProps } = useModalDismiss('hw-out');
  const title = holeTitle(lang, number);

  // The width a word has to fit — the frame's — followed across a resize.
  const [width, setWidth] = useState(() => Math.min(FRAME_MAX_PX, window.innerWidth - SIDES_PX));
  useEffect(() => {
    const onResize = () => setWidth(Math.min(FRAME_MAX_PX, window.innerWidth - SIDES_PX));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // The column: the longest word at full size, capped at the frame — so a word longer
  // than the frame is the one exception that shrinks.
  const longest = model.stops.reduce((max, stop) => Math.max(max, stop.word.length), 1);
  const column = Math.min(width, longest * WORD_PX + RANK_PX + CHIP_PX);
  const sizeOf = (word: string) =>
    Math.max(WORD_MIN_PX, Math.min(WORD_PX, (width - RANK_PX) / Math.max(1, word.length)));

  return createPortal(
    <dialog
      {...dialogProps}
      className={`hw-dialog${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <ModalHeader lang={lang} title={title} onClose={beginClose} />
      <div className="hw-scroll pixel-scroll">
        <div className="hw-frame">
          {/* The word itself, in the solved ink — what every word below was found for. */}
          {model.secret && <p className="hw-head">{model.secret}</p>}
          <ul className="hw-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${column}px, 1fr))` }}>
            {model.stops.map((stop) => (
              <li
                key={stop.rank}
                className={`hw-word${stop.revealed ? '' : ' hw-found'}`}
                style={
                  {
                    fontSize: `${sizeOf(stop.word)}px`,
                    '--rank-color': rankHeatColor(stop.rank),
                  } as CSSProperties
                }
                aria-label={srRouteStop(lang, stop)}
              >
                <span aria-hidden="true">
                  <span className="hw-text">{stop.word}</span>
                  <sup className="hw-rank">{stop.rank}</sup>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
