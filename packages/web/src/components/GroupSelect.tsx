import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GroupSummary } from '@whippin/shared';
import useDrum from '../hooks/useDrum';
import useModalDismiss from '../hooks/useModalDismiss';
import { HeaderBack } from './TopBar';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// WHICH GROUP (#271, user-decided 2026-09-14: "reuse the wheel component to select the
// group — wheel group on the left, global on the right"). The leaderboard's GROUP picker is
// the title's selection in its own dress and on its own screen: ONE drum, a row per group
// the player is in and a last row, NEW GROUP, that opens the create form instead of
// picking. It replaces the strip of named tabs, which scrolled sideways once four or five
// names outran a phone and gave nothing to a player in ten groups.
//
// The PICK LANDS AS THE FOLD BEGINS (the selection's rule): every door — the back chevron,
// a tap on the slot row, a tap outside the drum, Escape — sets `closing`, and the caller
// is told at once what the slot holds, so the board under the veil is already the picked
// group's when it lifts. A tap on a plain row only TURNS the drum. `useDrum` is the same
// physics the hole wheel and the title's drums turn on; this component supplies only the
// rows and the `write`.
//
// It is a full-screen dialog on flat `--bg` under the app's header row (`.wheel-dialog
// .puzzle-select` — the selection's exact dress, shared rather than restated: the chip,
// the fades, the stagger and the phone step-downs are one set of rules). Native <dialog>
// on `useModalDismiss`, so the board under it is inert.

const GAP = 14;
const VISIBLE = 5;

export default function GroupSelect({
  lang,
  groups,
  current,
  onPick,
  onNew,
  onClose,
}: {
  lang: LangCode;
  groups: readonly GroupSummary[];
  // The group the slot opens on (the active one), or null to open on NEW GROUP.
  current: string | null;
  // The fold's answer: the group in the slot — called as the fold BEGINS.
  onPick: (id: string) => void;
  // The fold on the NEW GROUP row.
  onNew: () => void;
  onClose: () => void;
}) {
  // FIRST hook, per the contract: a closed <dialog> is `display: none`, and the row height
  // is measured below.
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');

  const probe = useRef<HTMLSpanElement>(null);
  const [rowH, setRowH] = useState(0);
  useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return undefined;
    const update = () => setRowH(el.getBoundingClientRect().height);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const pitch = rowH + GAP;
  const ready = rowH > 0;

  // The rows: every group, then NEW GROUP last — the one row that is not a pick.
  const rows = [
    ...groups.map((group) => ({ key: group.id, label: group.name.toUpperCase(), id: group.id })),
    { key: 'new', label: t(lang, 'groupNew'), id: null },
  ];
  const initial = Math.max(0, current === null ? rows.length - 1 : rows.findIndex((row) => row.id === current));

  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drum = useDrum({
    ref: box,
    active: ready,
    count: rows.length,
    pitch,
    initial,
    write: (px) => {
      if (track.current) track.current.style.translate = `0 ${-px}px`;
    },
  });
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    drum.jump(initial);
  }, [drum, initial, ready]);

  // The fold BEGINS: the caller learns what the slot holds, once, while the veil is up.
  const moved = useRef(false);
  useEffect(() => {
    if (!closing || moved.current) return;
    moved.current = true;
    const row = rows[drum.peek()];
    if (!row) return;
    if (row.id === null) onNew();
    else onPick(row.id);
    // `rows` is rebuilt every render from props that do not change while the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing, drum, onNew, onPick]);

  // A drum that turns while its slot row holds the focus carries the focus with it (#267).
  useEffect(() => {
    if (box.current?.contains(document.activeElement)) {
      box.current.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
    }
  }, [drum.current]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        drum.glideBy(e.key === 'ArrowDown' ? 1 : -1);
      }
    },
    [drum],
  );

  const half = Math.floor(VISIBLE / 2);

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select group-select${closing ? ' closing' : ''}`}
      aria-label={t(lang, 'groupMenu')}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (drum.endedDrag()) return;
        const el = e.target as HTMLElement;
        const bare =
          el === e.currentTarget ||
          ['ps-cols', 'ps-drum', 'ps-track', 'ps-lead', 'ps-trail'].some((c) => el.classList.contains(c));
        if (bare && !closing) beginClose();
      }}
    >
      <div className="modal-bar">
        <div className="topbar-inner">
          <div className="topbar-left">
            <HeaderBack
              label={t(lang, 'ariaClose')}
              onBack={() => {
                if (!closing) beginClose();
              }}
            />
          </div>
          <div className="topbar-right" />
        </div>
      </div>
      <span ref={probe} className="ps-chip ps-probe" aria-hidden>
        X
      </span>
      {ready && (
        <div className="ps-cols">
          <div className="ps-drum" ref={box} style={{ height: VISIBLE * pitch - GAP }}>
            <div className="ps-track" ref={track}>
              <div className="ps-lead" style={{ height: half * pitch }} />
              {rows.map((row, i) => {
                const inSlot = i === drum.current;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`ps-row${inSlot ? ' on' : ''}${row.id === null ? ' ps-row-new' : ''}`}
                    style={{ height: rowH, marginBottom: GAP, '--i': Math.abs(i - drum.current) } as CSSProperties}
                    aria-current={inSlot ? 'true' : undefined}
                    tabIndex={inSlot ? 0 : -1}
                    aria-label={inSlot ? `${row.label}, ${t(lang, 'ariaClose')}` : row.label}
                    onClick={() => {
                      if (drum.tap(i) === 'slot') beginClose();
                    }}
                  >
                    <span className="ps-chip" data-focus-box>
                      {row.label}
                    </span>
                  </button>
                );
              })}
              <div className="ps-trail" style={{ height: half * pitch - GAP }} />
            </div>
          </div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
