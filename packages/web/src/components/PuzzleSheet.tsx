// THE ONE SHEET BEHIND THE TITLE (user-decided 2026-08-30): both axes of "which puzzle am I
// playing", in one place, as rows.
//
//     ENGLISH        ✓        the language      (was a right-hand chip onto /select)
//     FRANÇAIS
//     ───────────────
//     SENTENCE       ✓        the daily         (was the centred segmented switcher)
//     WORD
//
// No group titles: the hairline says where one question ends and the next begins, which is
// the account area's "a section is space and a title" rule with the space doing the work in
// a surface this small. The DAY is deliberately NOT here — it is a place (the calendar), and
// places are keys in the right group; a row here would be a second door onto one screen.
//
// It routes by the SURFACE it was opened from, which is what the retired mode tabs did: from
// the archive, the other daily means that daily's CALENDAR, never its live puzzle.
//
// It follows the app's modal contract (`useModalDismiss`) — opening focuses the DIALOG
// rather than its first control, Escape closes, and closing is a beat that waits on its own
// exit animation — with ONE deliberate departure: **a tap OUTSIDE it closes it.** The
// contract's "a backdrop tap is not a dismissal" was decided for full-SCREEN modals, which
// carry a header with a close chip; a menu hanging off a title has no chrome to hold one,
// and on a phone there is no Escape. Without the outside tap the only way to leave without
// choosing was to re-pick the current row, which nobody would guess. The dialog itself has
// no padding, so a click whose target IS the dialog can only have landed on the backdrop.
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import { LANGS, pathForArchive, pathForMode, type LangCode, type Mode } from '../langs';
import { navigate } from '../routing';

const MODES: { mode: Mode; key: 'modeSentence' | 'modeWord' }[] = [
  { mode: 'sentence', key: 'modeSentence' },
  { mode: 'word', key: 'modeWord' },
];

export default function PuzzleSheet({
  lang,
  mode,
  onArchive,
  onClose,
}: {
  lang: LangCode;
  mode: Mode;
  onArchive: boolean;
  onClose: () => void;
}) {
  // FIRST hook, per the contract: a closed <dialog> is `display: none`.
  const { closing, beginClose, dialogProps } = useModalDismiss('sheet-out');
  const pathFor = (l: LangCode, m: Mode) => (onArchive ? pathForArchive(l, m) : pathForMode(l, m));
  // Every row leaves the sheet. Closing is a beat, so the navigation rides its start and the
  // dialog animates out over the screen it just asked for.
  const go = (to: string) => {
    navigate(to);
    beginClose();
  };
  const row = (on: boolean, label: string, to: string) => (
    <button
      key={to}
      type="button"
      className={`sheet-row${on ? ' on' : ''}`}
      aria-current={on || undefined}
      onClick={() => (on ? beginClose() : go(to))}
    >
      <span className="sheet-label">{label}</span>
      {on && <span className="sheet-tick" aria-hidden="true" />}
    </button>
  );
  return (
    <dialog
      {...dialogProps}
      className={`puzzle-sheet${closing ? ' closing' : ''}`}
      aria-label={t(lang, 'puzzleMenu')}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget && !closing) beginClose();
      }}
    >
      <div className="sheet-body">
        <div className="sheet-group">
          {LANGS.map((l) => row(l.code === lang, l.native, pathFor(l.code, mode)))}
        </div>
        <div className="sheet-group">
          {MODES.map((m) => row(m.mode === mode, t(lang, m.key), pathFor(lang, m.mode)))}
        </div>
      </div>
    </dialog>
  );
}
