import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  anonName,
  AVATAR_CELLS,
  AVATAR_PALETTES,
  AVATAR_SIZE,
  blankAvatar,
  decodeAvatar,
  defaultAvatar,
  encodeAvatar,
  sanitizeName,
  NAME_MAX_LENGTH,
} from '@whippin/shared';
import { isUnknownDeviceAnswer, parseProfile, postProfileBody, profileUrl } from '../api';
import {
  deviceIdentity,
  ensureDeviceIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
  useDeviceIdentity,
} from '../identity';
import { prefetchTurnstileTokens } from '../turnstile';
import { withoutLocalIdentityDeploy } from '../state/localIdentityDeploy';
import { holdOwnFace, ownProfileWritten } from '../state/ownFace';
import ErrorScreen from '../components/ErrorScreen';
import { navigate } from '../routing';
import { ACCOUNT_PATH, type LangCode } from '../langs';
import useUiLang from '../hooks/useUiLang';
import { t } from '../i18n';
import Avatar from '../components/Avatar';
import { StatSlot } from '../components/AccountStats';
import { MARK } from '../components/boardMetrics';
import DitherWipe, { WIPE_MS, type WipeShot } from '../components/editor/DitherWipe';
import EditorCanvas, { type PaintFx } from '../components/editor/EditorCanvas';
import { canvasSide, cellAtPoint } from '../components/editor/picture';
import { cellLine, churnCells, drainStep, landStep, paintStroke, rollShape } from '../components/editor/tools';
import { foilSeed } from '../components/foil';
import FoilStamp from '../components/FoilStamp';
import { takeMark, type HandedMark } from '../components/markHandoff';
import LangTitle from '../components/LangTitle';
import { HeaderBack, HeaderLeft } from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
import { prefersReducedMotion } from '../hooks/useScramble';
import DiceIcon from '../assets/icons/dice.svg?react';
import ClearIcon from '../assets/icons/clear.svg?react';

// The #188 profile editor, a small PIXEL-ART STUDIO: the tool keys — DICE (a new SHAPE the
// assigned way, the palette kept), CLEAR (the drawing drained in the Bayer order) — over the
// sprite CANVAS (square cells on a 1px grid, in the corner brackets of a thing that takes the
// finger), which GROWS out of the very mark the player tapped on `/account` (`markHandoff`).
// Under it the palettes — each swatch the drawing itself in that palette ({bg, fg} pairs,
// user-decided 2026-08-19: two colours, nothing else, so picking a ground picks the ink with
// it) — then the LINE every board will draw for the player, the name typed ON it (how others
// see them, shown rather than said), and SAVE on the bottom edge, whose landing is the
// screen's one shiny thing: the FOIL STAMP. Every tool is an ordinary edit; SAVE is the
// deploy.
//
// Show-don't-tell throughout: the grid demonstrates itself under the finger and the
// swatches show their colours — no explanatory copy anywhere.

// The name rule — alphanumerics + underscores, case kept, accents FOLDED, capped —
// is `@whippin/shared`'s `sanitizeName`, because the SERVER applies the same one
// (user-decided 2026-08-19). Every path that writes `name` here goes through it: the
// initial read, the keystrokes, the composition's commit. So the value the editor
// holds is always something the route will accept, and the save body needs no pass
// of its own.

// What the initial read settled, and the reason the editor is GATED on it: the editor
// is only meaningful against the profile the server holds. Rendering an editable blank
// while the read is in flight invites edits the response then overwrites, and a failed
// read leaves the stored profile UNKNOWN — an editor started from that guess would save
// a blank over a real profile. A 404 is not a failure: it IS the answer "never
// customized" — and since 2026-08-20 that opens the editor on the player's ASSIGNED
// identity (anonName + defaultAvatar, the exact fallback every board row already
// shows), not on a blank: an editor that opens empty while the board wears a name and
// a mark reads as broken. The assigned values are also the BASELINE, so SAVE stays
// dark until something is actually changed.
// (This is the game route's own loading / error / content shape.)
type LoadState = 'loading' | 'ready' | 'failed';

// THE ASSIGNED NAME IS A DISPLAY VALUE, NEVER A STORED ONE — one rule, both directions
// (corrected 2026-08-20 on review; the first cut adopted the pseudonym as the save
// baseline on the reasoning that "storing it changes nothing anyone sees", which is
// false: every board gates its placeholder ink on the name being EMPTY, so storing the
// pseudonym flips that player's row from the muted placeholder to full primary and
// makes them indistinguishable from someone who deliberately chose that handle — and
// freezes their name against every later generator change).
//   READ  — an empty stored name shows as the assigned pseudonym, exactly as a board
//           row shows it (so a 404 and a name-less stored profile open identically).
//   WRITE — a name still equal to the assigned pseudonym was never typed, so the body
//           carries the empty name the assigned identity derives from.
// The BASELINE therefore lives in DISPLAY space (what the field holds) and the body in
// STORAGE space. A player who deliberately types their own pseudonym stores empty and
// renders the same text in the placeholder ink — the one accepted cost of the rule.
const nameForEditor = (stored: string, publicId: string) =>
  sanitizeName(stored) || anonName(publicId);
const nameForStore = (edited: string, publicId: string) =>
  edited === anonName(publicId) ? '' : edited;

// THE ASSIGNED MARK IS A DISPLAY VALUE TOO — the name rule's other half (PR-219 round-2
// review): a drawing still equal to the assigned mark the editor OPENED ON was never
// drawn, so the body carries the EMPTY avatar ('' — "no custom mark", which every reader
// already dresses as the account-derived face). Without this half, saving a name alone
// froze the placeholder grid into the row for good — on a tokenless open, the local
// SEED's grid, a face the account never had.
//   READ  — a null stored avatar opens on the assigned mark, exactly as a board row shows it.
//   WRITE — an avatar still equal to that assigned mark stores as the empty one.
const avatarForEditor = (stored: string | null, publicId: string) =>
  stored ?? defaultAvatar(publicId);
const avatarForStore = (encoded: string, publicId: string) =>
  encoded === defaultAvatar(publicId) ? '' : encoded;

// The GUARDED save body (PR-219 round-3 review, P1): when SAVE resolves an account the
// editor did NOT load — the deploy just minted one, recovered one from a pending token, or
// adopted one from another tab under an open tokenless editor — the baseline on screen was
// a PLACEHOLDER, never that account's profile. A whole-profile upsert built from it would
// wipe whatever the account already holds: change only the placeholder name and the '' in
// `avatar` deletes a custom mark; change only the drawing and the '' in `name` deletes a
// custom name. So the save first FETCHES what the account stores and carries every
// UNTOUCHED field forward verbatim; only a field the player actually changed from the
// placeholder speaks. Exported for the contract test — the wipe is the harshest thing this
// screen can do to an account.
export function guardedSaveBody(
  edited: { name: string; avatar: string },
  baseline: { name: string; avatar: string },
  // What the placeholder derived from (the local seed, or another account's id) — the
  // store-halves compare a CHANGED field against the pseudonym/mark the player was SHOWN.
  assignedFrom: string,
  // The account's stored profile; null is the 404 "never customized", where the intended
  // save applies in full.
  server: { name: string; avatar: string | null } | null,
): { name: string; avatar: string } {
  const nameChanged = edited.name !== baseline.name;
  const avatarChanged = edited.avatar !== baseline.avatar;
  return {
    name: nameChanged ? nameForStore(edited.name, assignedFrom) : (server?.name ?? ''),
    avatar: avatarChanged ? avatarForStore(edited.avatar, assignedFrom) : (server?.avatar ?? ''),
  };
}

// The SAVE button's two orthogonal facts: its visual PHASE (the label rolls down and
// out, the dot loader drops in from the top, holds, then the label rolls back up from
// the bottom) and whether the server REFUSED the write (the line under the button).
// The label itself always reads SAVE — the button animates, it never renames itself.
type SavePhase = 'idle' | 'saving' | 'restoring';
// `account` is the DEPLOY failing (#216 rework: a tokenless SAVE creates the account
// first); nothing was created and nothing was saved, and SAVE pressed again re-runs the whole
// tap. The two moderation refusals are VERDICTS on what was typed or drawn, answered AT the
// editor (the name, or the canvas); `account` and `error` are acts that did not land, on the
// error screen.
type SaveRefusal = 'name_rejected' | 'avatar_rejected' | 'account' | 'error' | null;

// The loader holds at least this long even on an instant answer — a flash of dots
// reads as a glitch — and the restore beat covers the label's roll-back animation.
const SAVE_DOTS_MIN_MS = 750;
const SAVE_RESTORE_MS = 240;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- THE STUDIO'S GEOMETRY (visual only: nothing here decides what is saved). The canvas's
// cell is a WHOLE, ODD number of px — the grid's pitch (cell + its 1px line) even, so the
// house's 2px dither lands on every cell's own edge (`editor/picture.ts`) — the largest the
// column holds (the frame: the canvas and its brackets' 8px of air each side) and the largest
// that leaves the whole editor on the screen with nothing scrolled, down to the ~550px an
// iPhone SE's browser leaves under its own bars. The chrome round the canvas — the bar's
// clearance, the tool keys, the frame's air, the swatches, the board line, SAVE, `.app`'s pads
// — is the CSS's own sum (EDITOR_CHROME_PX): a PHONE's (`max-width: 640px`), its SHORT dress
// on a screen this short (`.short`), and a DESKTOP's, where `.app` centres the column and the
// column is held at its full height from the first frame, so nothing moves when the tools
// arrive. The height is the one the screen had BEFORE a soft keyboard took part of it: the
// editor never jumps while its name is typed. One layout at every width.
const CELL_MIN = 15;
// The largest: a 417px frame in the desktop's 430px column, as near its edges as a whole odd
// cell comes (one more would not fit).
const CELL_MAX = 39;
const FRAME_AIR_PX = 8;
const SWATCH_PX = 48;
// A swatch's mark: four whole pixels a cell, in its 48px target.
const SWATCH_MARK_PX = 40;
// The swatches spread across the frame; on a canvas too small for that they keep this much
// between them, centred on it.
const SWATCH_GAP_MIN_PX = 4;
const PHONE_MAX_PX = 640;
const SHORT_PX = 600;
const EDITOR_CHROME_PX = { tall: 346, short: 318, desktop: 370 } as const;
// The desktop column's own height round the canvas (EDITOR_CHROME_PX.desktop less `.app`'s 48).
const DESKTOP_COLUMN_PX = 322;
// The canvas grows out of the masthead's mark in whole-pixel steps, a cell this much bigger
// each step, a step this long.
const GROW_CELL_STEP = 4;
const GROW_STEP_MS = 50;
// The masthead's mark's own size, when nothing hands it over (a direct load): the growth
// starts there, from the canvas's centre.
const GROW_FROM_PX = 50;
// The cell whose canvas comes nearest a mark of this side.
const cellForSide = (side: number) => Math.max(1, Math.round((side - canvasSide(0)) / AVATAR_SIZE));
// The dice: a short churn — four shapes, one quick shake of the die, on the canvas alone — then
// the new shape landing over the frozen churn in the Bayer order, in hard steps; CLEAR: the
// Bayer drain, the same rhythm.
const DICE_FRAME_MS = 90;
const DICE_CHURN_MS = 360;
const DICE_LAND_STEPS = 6;
const DICE_LAND_STEP_MS = 40;
const CLEAR_STEPS = 6;
const CLEAR_STEP_MS = 50;
// A refused save SHAKES the frame, in whole pixels, a step a frame.
const REFUSE_SHAKE: readonly (readonly [number, number])[] = [
  [-4, 0],
  [4, 0],
  [-2, 0],
  [2, 0],
];
const REFUSE_SHAKE_FRAME_MS = 50;

// The largest whole ODD number of px at most `room` (the grid's pitch even), held in bounds.
const oddCell = (room: number) => {
  const whole = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(room)));
  return whole % 2 === 1 ? whole : whole - 1;
};

// What an account STORES: its profile, or null for the 404 "never customized". Anything
// else — transport, a 5xx, a malformed body — THROWS: the stored profile is unknown, and
// neither reader (the editor's load, the guarded save) may guess it.
async function readStoredProfile(publicId: string): Promise<ReturnType<typeof parseProfile> | null> {
  const response = await fetch(profileUrl(publicId));
  if (response.ok) return parseProfile(await response.json());
  if (response.status === 404) return null;
  throw new Error(`profile answered ${response.status}`);
}

// THE PALETTES, across the frame: each swatch the drawing itself, worn in that palette — a
// preview of the choice, not a chip of colour — and only the one in hand framed in white
// corners. ONE choice (a radio group): Tab lands on the one in hand, the arrows choose. Memoized
// on the drawing the previews follow (`shownPreview`, a beat behind a stroke), so a stroke's
// own render passes them by.
const Swatches = memo(function Swatches({
  lang,
  palette,
  cells,
  busy,
  onPick,
  onKey,
  refs,
}: {
  lang: LangCode;
  palette: number;
  cells: readonly number[];
  busy: boolean;
  onPick: (index: number) => void;
  onKey: (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
  refs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  return (
    <div className="profile-palettes" role="radiogroup" aria-label={t(lang, 'ariaPalette')}>
      {AVATAR_PALETTES.map((option, index) => (
        <button
          key={option.name}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          className={`profile-swatch${palette === index ? ' sel' : ''}`}
          style={{ '--i': index } as React.CSSProperties}
          aria-label={`${t(lang, 'ariaPalette')} ${option.name}`}
          aria-checked={palette === index}
          aria-disabled={busy || undefined}
          tabIndex={palette === index ? 0 : -1}
          onClick={() => onPick(index)}
          onKeyDown={(e) => onKey(e, index)}
        >
          <Avatar avatar={encodeAvatar(index, cells)} size={SWATCH_MARK_PX} sharp />
        </button>
      ))}
    </div>
  );
});

// The board line's mark, memoized the same way. A save that landed HOPS it once (keyed on the
// stamp by its parent, so each landing replays the hop).
const LineMark = memo(function LineMark({ avatar, stamp }: { avatar: string; stamp: number }) {
  return (
    <span className={`profile-line-mark${stamp ? ' hop' : ''}`} aria-hidden="true">
      <Avatar avatar={avatar} size={MARK} sharp />
    </span>
  );
});

export default function Profile() {
  // No puzzle to take a language from: same resolution as the `/` redirect.
  const lang = useUiLang();

  // OPENING THE EDITOR DEPLOYS NOTHING (#216 trigger rework, user-decided 2026-08-24):
  // the identity is whatever the device holds, and SAVE is the deploy button. Reactive so
  // the devices list below appears the moment an account exists.
  const identity = useDeviceIdentity();
  const ensureLocalSeed = useGameStore((s) => s.ensureLocalSeed);
  // The id the editor's DISPLAY baseline derives from — the account when one exists, the
  // persisted local seed otherwise (the leaderboard strip's own placeholder). It is what
  // the save body's name rule compares against: a name still equal to the pseudonym THE
  // PLAYER WAS SHOWN was never typed, whichever id derived it.
  const [assignedFrom, setAssignedFrom] = useState('');
  // WHICH account's profile the editor's fields were loaded from — null for a tokenless
  // open (the placeholder). The save compares it against the account it resolves: a
  // mismatch means the baseline was never that account's profile, and the guarded path
  // (guardedSaveBody) fetches before it may upsert.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [palette, setPalette] = useState(0);
  const [cells, setCells] = useState<number[]>(() => new Array<number>(AVATAR_CELLS).fill(0));
  // The drawing as the last edit left it, read by the next one in the same tick (a fast drag
  // delivers several samples before React renders) and re-synced on every commit.
  const cellsRef = useRef(cells);
  useLayoutEffect(() => {
    cellsRef.current = cells;
  }, [cells]);
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [refused, setRefused] = useState<SaveRefusal>(null);
  // A refused NAME shakes its field (AddressField's gesture), and the refusal's one note
  // under the line is what the field and the canvas point at.
  const [nameShake, setNameShake] = useState(false);
  const refusalId = useId();
  // Where the canvas is told what an edit just changed: a changed cell POPS (`EditorCanvas`) —
  // and ONLY a changed one, so loading a stored drawing pops nothing.
  const fx = useRef<PaintFx | null>(null);
  // Every edit goes through here: the drawing held, and the pops it throws.
  const commitCells = useCallback((next: number[], on: readonly number[] = [], off: readonly number[] = []) => {
    cellsRef.current = next;
    setCells(next);
    fx.current?.pop(on, 'in');
    fx.current?.pop(off, 'out');
  }, []);
  // What the server holds (or the blank start before any save): SAVE only lights up
  // when the editor differs from it, and a successful save re-baselines.
  const [baseline, setBaseline] = useState(() => ({ name: '', avatar: blankAvatar() }));
  const [load, setLoad] = useState<LoadState>('loading');
  // Bumped by RETRY — re-runs the read the way usePuzzle's retry re-runs its fetch.
  const [attempt, setAttempt] = useState(0);

  // ---- the TOOLS (each an ordinary edit; SAVE stays the deploy). DICE and CLEAR PLAY (a
  // churn, a drain), and while one plays the canvas takes no paint and the other tool waits.
  const [tool, setTool] = useState<'dice' | 'clear' | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // The dice's churn, shown over the drawing while it rolls (the palette never changes) — on the
  // CANVAS only: the swatches and the board line hold the drawing the roll started from until
  // the new shape has landed, so one die rolls rather than the whole screen strobing.
  const [churn, setChurn] = useState<number[] | null>(null);
  const [rollFrom, setRollFrom] = useState<number[] | null>(null);
  const toolTimers = useRef<number[]>([]);
  useEffect(() => () => toolTimers.current.forEach((id) => window.clearTimeout(id)), []);

  // ---- the canvas's drawing (visual only).
  const screenRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(0);
  // The canvas while it GROWS in (below): the cell it is drawn at, and where it stands in its box.
  const [grow, setGrow] = useState<{ cell: number; x: number; y: number } | null>(null);
  // The cell the canvas is DRAWN at: its own, or the growth's step — what a finger reads.
  const drawnCell = grow?.cell ?? cellPx;
  const cellRef = useRef(drawnCell);
  cellRef.current = drawnCell;
  // What the canvas WAS, swept off it through the dither on a palette switch. The switch is told
  // by the CANVAS first: the board line keeps the palette it wore until the sweep has passed (a
  // second tap mid-sweep holds it on, to the last sweep's end).
  const [wipe, setWipe] = useState<WipeShot | null>(null);
  const wipeKey = useRef(0);
  const [linePalette, setLinePalette] = useState<number | null>(null);
  const lineTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(lineTimer.current), []);
  // Bumped by a save that LANDED (the stamp), and by one REFUSED (the shake).
  const [stamp, setStamp] = useState(0);
  const [refusedShake, setRefusedShake] = useState(0);
  // A stroke is down (the frame's corners light), and the cell under a fine pointer (ringed).
  const [painting, setPainting] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  // Open the editor on what `id` stores. Both READ halves: the assigned pseudonym stands in
  // for an empty stored name, the assigned mark for a null stored avatar. The name is also
  // sanitized on the way in (a no-op on anything the server stored, since it enforces the
  // same rule). The BASELINE is those same display values, or a value the editor cannot
  // reproduce would light SAVE up with nothing edited.
  const openOn = (storedName: string, storedAvatar: string | null, id: string) => {
    const shownName = nameForEditor(storedName, id);
    const shownAvatar = avatarForEditor(storedAvatar, id);
    const decoded = decodeAvatar(shownAvatar);
    setName(shownName);
    setPalette(decoded.palette);
    cellsRef.current = decoded.cells;
    setCells(decoded.cells);
    // A cell's pop belongs to the edit that made it: re-bound fields start with none.
    fx.current?.clear();
    setLinePalette(null);
    setBaseline({ name: shownName, avatar: shownAvatar });
  };

  // Read this identity's stored profile, and hold the editor back until it answers
  // (see LoadState). A 404 is the answer "never customized" and lands READY on the
  // blank start; anything else — transport, 5xx, a malformed body — is FAILED, which
  // offers RETRY rather than a blank editor that could save over the real profile.
  //
  // A TOKENLESS editor opens WITHOUT any request (#216 trigger rework): the placeholder
  // identity the local seed derives IS the answer — the same face the leaderboard strip
  // wears — and those values are the baseline, so SAVE stays dark until something is
  // actually changed. Deliberately keyed on [attempt] alone: an identity arriving under
  // an OPEN editor (a deploy elsewhere, another tab) must not reload the fields out from
  // under an edit in progress — the save path resolves the identity live.
  useEffect(() => {
    let cancelled = false;
    let epoch: string | null = null;
    setLoad('loading');
    (async () => {
      try {
        const held = deviceIdentity();
        if (held === null) {
          const seed = ensureLocalSeed();
          if (cancelled) return;
          setAssignedFrom(seed);
          setLoadedFor(null);
          openOn('', null, seed);
          setLoad('ready');
          return;
        }
        epoch = identityEpochOf(held);
        const publicId = held.accountId;
        setAssignedFrom(publicId);
        setLoadedFor(publicId);
        const stored = await readStoredProfile(publicId);
        if (cancelled || identityEpoch() !== epoch) return;
        // Never customized (null): open on the assigned identity the boards already show
        // (see the gating note above) — the same READ halves, over an empty row.
        openOn(stored?.name ?? '', stored?.avatar ?? null, publicId);
        setLoad('ready');
      } catch {
        // App remounts on an identity departure, but the fence is still explicit here:
        // a late malformed body/fetch failure from A must not turn B's fresh editor into a
        // failure if the component lifecycle and the answer cross in the same turn.
        if (!cancelled && (epoch === null || identityEpoch() === epoch)) setLoad('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, ensureLocalSeed]);
  // The one challenge a tokenless SAVE will spend on its deploy, in hand before the tap.
  useEffect(() => {
    if (identity === null) prefetchTurnstileTokens(1);
  }, [identity]);

  // ---- the name field. Sanitizing a CONTROLLED input's value makes React reassign
  // `node.value`, and assigning `.value` collapses the text cursor to the END of the
  // field — React's own save/restore is gated on the focused element having CHANGED
  // (`restoreSelection`), and it never does here, so nothing puts the caret back.
  // Typing at the end hides it; typing a space into the middle of a name does not.
  // So the caret is placed by hand: sanitizing the PREFIX up to the cursor gives its
  // new index exactly, which a straight index carry-over would not — folding `é` and
  // expanding `œ` both change the length before the cursor.
  const nameRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const placeCaret = useCallback(() => {
    const caret = caretRef.current;
    caretRef.current = null;
    const input = nameRef.current;
    if (caret === null || input === null || document.activeElement !== input) return;
    input.setSelectionRange(caret, caret);
  }, []);
  // On a render this rides the commit, and React's own post-event restore then finds
  // the values already equal and writes nothing.
  useLayoutEffect(placeCaret);

  // A composition (a dead key, an IME) has to be left alone while it is open: rewriting
  // the value under it kills the composition, so an AZERTY `^` would commit as `_` and
  // the `î` it was building would never arrive. The raw value is still mirrored into
  // state — the input stays controlled, so React does not reassign and the caret does
  // not move — and the rule lands on `compositionend`, over the composed character.
  const composingRef = useRef(false);
  const applyName = (raw: string, at: number | null) => {
    const next = sanitizeName(raw);
    caretRef.current = sanitizeName(raw.slice(0, at ?? raw.length)).length;
    // React rewrites a controlled input's value after the event EVEN WHEN the state
    // does not change (`finishEventHandler` flushes, then restores), so a keystroke
    // that sanitizes back onto the name already held — a space typed over an existing
    // `_` — still moves the caret, with no render for the layout effect to ride. A
    // microtask lands after that restore.
    if (next === name) queueMicrotask(placeCaret);
    setName(next);
  };

  // ---- painting. One STROKE value per gesture: starting on a painted cell erases (so
  // tap toggles), and dragging paints that same value throughout — along the LINE from the
  // last cell the finger crossed (`cellLine`), so a fast drag leaves no gap. The cell is read
  // off the pointer's place on the canvas (`cellAtPoint`, the grid's own geometry), never off
  // the element under it: the canvas wears overlays (the sweep, the foil) and grows in, drawn
  // at the growth's cell, from where the mark stood. A stroke is ONE pointer's: a second
  // finger landing on the canvas mid-stroke is ignored, never joined to the first by a line.
  const strokeRef = useRef<0 | 1 | null>(null);
  const pointerRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);
  const cellAt = useCallback((x: number, y: number): number | null => {
    const el = canvasRef.current;
    const cell = cellRef.current;
    if (!el || cell <= 0) return null;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return null;
    // The cell the canvas is drawn at (the growth's step while it grows in), at the box's scale.
    const scale = box.width / canvasSide(cell);
    return cellAtPoint((x - box.left) / scale, (y - box.top) / scale, cell);
  }, []);
  const paintTo = useCallback(
    (index: number | null) => {
      const stroke = strokeRef.current;
      if (stroke === null) return;
      // Off the canvas, the line breaks: coming back in elsewhere starts a new run.
      if (index === null) {
        lastRef.current = null;
        return;
      }
      const from = lastRef.current;
      if (from === index) return;
      lastRef.current = index;
      const { cells: next, changed } = paintStroke(cellsRef.current, from === null ? [index] : cellLine(from, index), stroke);
      if (changed.length === 0) return;
      // Every changed cell pops, and every inked one throws its sparks.
      if (stroke === 1) commitCells(next, changed);
      else commitCells(next, [], changed);
      setRefused(null);
    },
    [commitCells],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (toolRef.current !== null || pointerRef.current !== null) return;
      const index = cellAt(e.clientX, e.clientY);
      if (index === null) return;
      strokeRef.current = cellsRef.current[index] === 1 ? 0 : 1;
      pointerRef.current = e.pointerId;
      lastRef.current = null;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPainting(true);
      paintTo(index);
    },
    [cellAt, paintTo],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A fine pointer's cell wears the ring.
      if (e.pointerType === 'mouse') setHover(cellAt(e.clientX, e.clientY));
      if (strokeRef.current === null || e.pointerId !== pointerRef.current) return;
      // A fast drag's skipped samples (coalesced events) are walked too.
      const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
      for (const sample of events.length > 0 ? events : [e.nativeEvent]) paintTo(cellAt(sample.clientX, sample.clientY));
    },
    [cellAt, paintTo],
  );
  const endStroke = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerRef.current) return;
    strokeRef.current = null;
    pointerRef.current = null;
    lastRef.current = null;
    setPainting(false);
  }, []);

  // DICE: the tile CHURNS on the waiting tile's noise (every frame a plausible creature, in
  // the palette already chosen), then the new shape LANDS over the last frame of it in the
  // Bayer order — CLEAR's drain run the other way, each changed cell with its own pop — and
  // the landed shape is the edit.
  const roll = useCallback(() => {
    if (toolRef.current !== null) return;
    const from = cellsRef.current;
    const target = rollShape(from);
    if (prefersReducedMotion()) {
      commitCells(target);
      setRefused(null);
      return;
    }
    setTool('dice');
    setRollFrom(from);
    // The churn hides every cell's pop; the drawing it replaces pops nothing more.
    fx.current?.clear();
    const frames = Math.ceil(DICE_CHURN_MS / DICE_FRAME_MS);
    const offset = Math.floor(Math.random() * 1000);
    for (let f = 0; f < frames; f += 1) {
      toolTimers.current.push(window.setTimeout(() => setChurn(churnCells(offset + f)), f * DICE_FRAME_MS));
    }
    // The churn's last frame becomes the canvas, and the shape lands over it.
    toolTimers.current.push(
      window.setTimeout(() => {
        setChurn(null);
        commitCells(churnCells(offset + frames - 1));
      }, DICE_CHURN_MS),
    );
    for (let step = 1; step <= DICE_LAND_STEPS; step += 1) {
      toolTimers.current.push(
        window.setTimeout(() => {
          const { cells: next, on, off } = landStep(cellsRef.current, target, step, DICE_LAND_STEPS);
          if (on.length > 0 || off.length > 0) commitCells(next, on, off);
          if (step === DICE_LAND_STEPS) {
            setTool(null);
            setRollFrom(null);
            setRefused(null);
          }
        }, DICE_CHURN_MS + step * DICE_LAND_STEP_MS),
      );
    }
  }, [commitCells]);

  // CLEAR: the drawing DRAINS — its cells go out in the Bayer order, in hard steps, each with
  // its own small shrink.
  const clear = useCallback(() => {
    if (toolRef.current !== null) return;
    if (prefersReducedMotion()) {
      commitCells(new Array<number>(AVATAR_CELLS).fill(0));
      setRefused(null);
      return;
    }
    setTool('clear');
    for (let step = 1; step <= CLEAR_STEPS; step += 1) {
      toolTimers.current.push(
        window.setTimeout(() => {
          const { cells: next, gone } = drainStep(cellsRef.current, step, CLEAR_STEPS);
          if (gone.length > 0) commitCells(next, [], gone);
          if (step === CLEAR_STEPS) {
            setTool(null);
            setRefused(null);
          }
        }, step * CLEAR_STEP_MS),
      );
    }
  }, [commitCells]);

  // The editor is FROZEN while a save runs (its two round trips can take real time on a
  // phone, and the GUARDED success path re-binds every field to the merged server truth):
  // an edit made mid-save would be silently replayed over when the answer lands — the grid
  // visibly snapping back, SAVE greying out as though the change had been stored.
  const saving = phase !== 'idle';
  // A tool playing or a save running: the canvas takes no paint and the controls wait. They
  // say so (`aria-disabled`) without leaving the keyboard's reach — a `disabled` control
  // drops the focus it holds to the page.
  const busy = saving || tool !== null;

  const pickPalette = (index: number) => {
    if (index === palette || busy) return;
    wipeKey.current += 1;
    setWipe({ palette, cells: churn ?? cells, key: wipeKey.current });
    setPalette(index);
    setRefused(null);
    window.clearTimeout(lineTimer.current);
    if (prefersReducedMotion()) return;
    setLinePalette((held) => held ?? palette);
    lineTimer.current = window.setTimeout(() => setLinePalette(null), WIPE_MS);
  };

  // One encode per render, shared by the dirty check, the save body and the stamp.
  const encoded = encodeAvatar(palette, cells);
  // No trim on either side: the rule has no room for whitespace at all (it sanitizes
  // to `_`), the baseline is sanitized on load, and the SERVER stores the body it is
  // sent verbatim — so the two strings compared here are the same two strings the
  // route holds, and the re-baseline below is exact.
  const dirty = name !== baseline.name || encoded !== baseline.avatar;
  // What the canvas SHOWS: the drawing, or the dice's churn over it while it rolls. What the
  // swatches and the board line preview: the drawing, held on the one the roll started from
  // while the die is rolling.
  const shownCells = churn ?? cells;
  const previewCells = rollFrom ?? cells;
  // The previews follow the drawing a beat behind (`useDeferredValue`): six outlines traced per
  // painted cell would hold up a fast stroke, so they redraw once the stroke lets React breathe.
  const shownPreview = useDeferredValue(previewCells);

  // THE CANVAS'S CELL, off the column's width and the screen's height (see EDITOR_CHROME_PX),
  // and the whole-pixel offsets that follow from it: the frame centred in the column, the tool
  // keys and the board line on the canvas's left edge, the swatches spread across the frame on
  // whole-pixel gaps. Measured from the first frame, while the stored profile is still being
  // read, so the canvas's box is already where the canvas will stand.
  const [layout, setLayout] = useState({ short: false, frameAt: 0, swatchGap: 0, swatchesAt: 0, column: 0 });
  const heldHeight = useRef({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return undefined;
    const measure = () => {
      const width = screen.clientWidth;
      // A soft keyboard shrinks the window while the name is typed (`resizes-content`): the
      // height it leaves is not the screen's, and the editor holds the one it had.
      const typing = document.activeElement === nameRef.current && heldHeight.current.width === width;
      const height = typing ? Math.max(heldHeight.current.height, window.innerHeight) : window.innerHeight;
      heldHeight.current = { width, height };
      const phone = window.innerWidth <= PHONE_MAX_PX;
      const short = phone && height <= SHORT_PX;
      const chrome = phone ? EDITOR_CHROME_PX[short ? 'short' : 'tall'] : EDITOR_CHROME_PX.desktop;
      const byWidth = (width - 2 * FRAME_AIR_PX - canvasSide(0)) / AVATAR_SIZE;
      const byHeight = (height - chrome - canvasSide(0)) / AVATAR_SIZE;
      const cell = oddCell(Math.min(byWidth, byHeight));
      const frame = canvasSide(cell) + 2 * FRAME_AIR_PX;
      const frameAt = Math.max(0, Math.floor((width - frame) / 2));
      const swatchGap = Math.max(
        SWATCH_GAP_MIN_PX,
        Math.floor((frame - AVATAR_PALETTES.length * SWATCH_PX) / (AVATAR_PALETTES.length - 1)),
      );
      const swatches = AVATAR_PALETTES.length * SWATCH_PX + (AVATAR_PALETTES.length - 1) * swatchGap;
      const swatchesAt = Math.max(0, frameAt + Math.floor((frame - swatches) / 2));
      // On desktop `.app` centres the column: a column whose height leaves an odd remainder
      // would stand on a half pixel and blur the canvas, so it takes the one pixel more.
      let column = 0;
      const app = screen.parentElement;
      if (!phone && app) {
        const pad = getComputedStyle(app);
        const room = app.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
        const held = canvasSide(cell) + DESKTOP_COLUMN_PX;
        column = held < room ? held + ((room - held) % 2) : 0;
      }
      setCellPx((prev) => (prev === cell ? prev : cell));
      setLayout((prev) =>
        prev.short === short &&
        prev.frameAt === frameAt &&
        prev.swatchGap === swatchGap &&
        prev.swatchesAt === swatchesAt &&
        prev.column === column
          ? prev
          : { short, frameAt, swatchGap, swatchesAt, column },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(screen);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  // THE MARK HANDED OVER by the masthead's tap (`markHandoff`), taken once as the editor opens:
  // while the stored profile is read the mark stays FROZEN in the very box it stood in, and the
  // canvas then grows out of it. A note that cannot be that mark (off the screen, the wrong
  // size) is dropped: the canvas then grows from its own centre.
  const [handed, setHanded] = useState<HandedMark | null>(null);
  const handedRef = useRef<HandedMark | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (handedRef.current !== undefined) return;
    const note = takeMark();
    const box = note?.rect;
    const usable =
      box !== undefined &&
      box.width >= 20 &&
      box.width <= 120 &&
      Math.abs(box.width - box.height) < 1 &&
      box.bottom > 0 &&
      box.top < window.innerHeight &&
      box.right > 0 &&
      box.left < window.innerWidth;
    handedRef.current = usable ? note : null;
    setHanded(handedRef.current);
  }, []);
  // A read that FAILED lets the handed mark go: the box is the still slate now, and a RETRY
  // breathes the slate in the canvas's box and grows from its centre, like a direct load —
  // never the masthead's small mark back in the corner it stood in on a screen left behind.
  useEffect(() => {
    if (load !== 'failed' || handedRef.current === null) return;
    handedRef.current = null;
    setHanded(null);
  }, [load]);

  // THE CANVAS GROWS OUT OF THE MASTHEAD'S MARK as the editor opens: DRAWN at a cell
  // GROW_CELL_STEP px bigger each step, from the mark's own size up to the canvas's — the picture
  // repainted at every step, its cells and its grid's lines whole, never a bitmap scaled between
  // two sizes — and, opened from the masthead, out of the very box the mark stood in, travelling
  // to its place on whole pixels as it grows. A direct load grows from the canvas's own centre.
  const growTimers = useRef<number[]>([]);
  useEffect(() => () => growTimers.current.forEach((id) => window.clearTimeout(id)), []);
  const grown = useRef(false);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || load !== 'ready' || cellPx <= 0 || grown.current) return;
    grown.current = true;
    if (prefersReducedMotion()) return;
    const from = handedRef.current?.rect ?? null;
    const side = canvasSide(cellPx);
    const at = el.getBoundingClientRect();
    const steps: number[] = [];
    for (let c = cellForSide(from ? from.width : GROW_FROM_PX); c < cellPx; c += GROW_CELL_STEP) steps.push(c);
    if (steps.length === 0) return;
    steps.push(cellPx);
    const last = steps.length - 1;
    const step = (k: number) => {
      const drawn = canvasSide(steps[k]);
      if (!from) return { cell: steps[k], x: Math.floor((side - drawn) / 2), y: Math.floor((side - drawn) / 2) };
      const left = 1 - k / last;
      return { cell: steps[k], x: Math.round((from.left - at.left) * left), y: Math.round((from.top - at.top) * left) };
    };
    // The first step in this very commit: the mark handed over is gone from the frame it opens.
    setGrow(step(0));
    for (let k = 1; k <= last; k += 1) {
      growTimers.current.push(window.setTimeout(() => setGrow(k === last ? null : step(k)), k * GROW_STEP_MS));
    }
  }, [cellPx, load]);

  // A REFUSED save shakes the frame, in whole pixels — the drawing's refusal at the canvas
  // itself, a failed act before the ErrorScreen says why. (A refused NAME shakes the name.)
  useEffect(() => {
    const frame = frameRef.current;
    if (refusedShake === 0 || !frame || prefersReducedMotion() || typeof frame.animate !== 'function') return;
    const frames: Keyframe[] = REFUSE_SHAKE.map(([dx, dy], k) => ({
      translate: `${dx}px ${dy}px`,
      offset: k / REFUSE_SHAKE.length,
      easing: 'steps(1, end)',
    }));
    frames.push({ translate: '0 0', offset: 1 });
    frame.animate(frames, { duration: REFUSE_SHAKE.length * REFUSE_SHAKE_FRAME_MS });
  }, [refusedShake]);

  // A refused DRAWING stands until the drawing changes (a refused name, until it is edited).
  useEffect(() => {
    setRefused((held) => (held === 'avatar_rejected' ? null : held));
  }, [cells]);

  const onSave = useCallback(async () => {
    // The last door the rule stands in: a composition still OPEN when SAVE is tapped
    // would leave `name` holding its raw mirror, so it lands here too. A no-op on every
    // settled value, and the baseline below re-reads it, so a save can never leave the
    // editor differing from what it just stored.
    const clean = sanitizeName(name);
    setName(clean);
    setPhase('saving');
    setRefused(null);
    const started = Date.now();
    // The outcome is decided while the dots run; the phases below only pace how the
    // button tells it — then the error surface says it (#216 rework), where a refusal
    // used to be an inline line.
    let outcome: SaveRefusal = null;
    let epoch: string | null = null;
    // SAVING IS A DEPLOY BUTTON (#216 trigger rework, user-decided 2026-08-24): a
    // tokenless editor creates the account on this very tap, then saves into it — one
    // tap, the button's own dots for both legs. A deploy that fails saves nothing and
    // created nothing; TRY AGAIN re-runs the whole tap.
    let current = deviceIdentity();
    // The header's face (`useOwnFace`) reads the profile again once this save has written
    // it — and when this tap MINTS the account, it keeps the seed's face until then rather
    // than reading a profile that does not exist yet (`state/ownFace.ts`).
    const release = current === null ? holdOwnFace() : null;
    let written = false;
    try {
      if (current === null) {
        try {
          // The ONE acquisition the locally-decided username must NOT deploy into: this tap
          // carries the player's OWN typed fields a beat later, so letting the placeholder
          // race it would either lose the save or store a name nobody chose.
          current = await withoutLocalIdentityDeploy(() => ensureDeviceIdentity());
        } catch {
          current = null;
          outcome = 'account';
        }
      }
      if (current !== null) {
        epoch = identityEpochOf(current);
        // The body is STORAGE space: an untouched assigned pseudonym stores as the empty
        // name every surface derives it from (nameForStore's WRITE half) — compared against
        // the pseudonym the player was actually SHOWN (`assignedFrom`: the account's, or the
        // local seed's on a tokenless open). The baseline handling below stays in DISPLAY
        // space, so a save can never leave the editor differing from what it just stored.
        //
        // **A save into an account the editor did NOT load is GUARDED** (PR-219 round-3
        // review, P1): the baseline was a placeholder, so the account's stored profile is
        // fetched first and every untouched field carried forward verbatim — a recovered or
        // adopted account with a real profile must not have its name or mark wiped by the
        // '' an untouched placeholder field would otherwise send.
        const guarded = current.accountId !== loadedFor;
        let fields: { name: string; avatar: string } | null = null;
        if (guarded) {
          try {
            const stored = await readStoredProfile(current.accountId);
            if (identityEpoch() !== epoch) return;
            // Never customized (null): the intended save applies in full.
            fields = guardedSaveBody({ name: clean, avatar: encoded }, baseline, assignedFrom, stored);
          } catch {
            if (identityEpoch() !== epoch) return;
            // What the account holds is UNKNOWN — refusing beats risking the wipe the
            // guard exists to prevent. TRY AGAIN re-runs the whole tap.
            outcome = 'error';
          }
        } else {
          fields = {
            name: nameForStore(clean, assignedFrom),
            avatar: avatarForStore(encoded, assignedFrom),
          };
        }
        if (fields !== null && outcome === null) {
          const body = { token: current.token, ...fields };
          try {
            const response = await postProfileBody(profileUrl(), body);
            if (identityEpoch() !== epoch) return;
            if (response.ok) {
              if (guarded) {
                // The editor is now THIS account's: re-bind it to the stored truth the save
                // just merged, in DISPLAY space — a kept server name or mark appears, the
                // placeholder identity is gone, and a further save is an ordinary one.
                openOn(body.name, body.avatar || null, current.accountId);
                setAssignedFrom(current.accountId);
                setLoadedFor(current.accountId);
              } else {
                // DISPLAY space, like the name half: the body may have stored the empty
                // avatar, but what the editor holds — and must compare against — is the
                // drawing shown.
                setBaseline({ name: clean, avatar: encoded });
              }
              written = true;
            } else {
              const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
              if (identityEpoch() !== epoch) return;
              // A device signed out from elsewhere raises the screen that explains it; the
              // save still reports as failed, because it was. (The body was already read
              // for the moderation codes, so the shared PREDICATE decides directly.)
              if (isUnknownDeviceAnswer(response.status, refusal?.error)) {
                markDeviceSignedOut(epoch);
              }
              outcome =
                refusal?.error === 'name_rejected' || refusal?.error === 'avatar_rejected'
                  ? refusal.error
                  : 'error';
            }
          } catch {
            if (identityEpoch() !== epoch) return;
            outcome = 'error';
          }
        }
      }
    } finally {
      if (release) release(written);
      else if (written) ownProfileWritten();
    }
    await sleep(Math.max(0, SAVE_DOTS_MIN_MS - (Date.now() - started)));
    if (epoch !== null && identityEpoch() !== epoch) return;
    setRefused(outcome);
    // The landing, told where it belongs (visual only): a save that LANDED is stamped in foil
    // on the canvas; a refused NAME shakes the name; any other refusal shakes the card.
    if (written && outcome === null) setStamp((n) => n + 1);
    else if (outcome === 'name_rejected') {
      setNameShake(false);
      requestAnimationFrame(() => setNameShake(true));
    } else if (outcome !== null) setRefusedShake((n) => n + 1);
    setPhase('restoring');
    await sleep(SAVE_RESTORE_MS);
    if (epoch !== null && identityEpoch() !== epoch) return;
    setPhase((held) => (held === 'restoring' ? 'idle' : held));
  }, [name, encoded, assignedFrom, baseline, loadedFor]);

  // What a save that did not land puts on the error surface (#216 rework): a failed deploy or
  // a transport failure — the act is pressed again from here, SAVE still lit.
  const saveError =
    refused === 'account'
      ? { title: t(lang, 'failedAccount'), note: t(lang, 'failedAccountNote') }
      : refused === 'error'
        ? { title: t(lang, 'profileSaveFailed'), note: t(lang, 'failedSaveNote') }
        : null;
  // What the editor answers itself: the moderation VERDICTS, one note under the name's line
  // until the refused value is edited.
  const refusalNote =
    refused === 'name_rejected'
      ? t(lang, 'profileNameRejectedNote')
      : refused === 'avatar_rejected'
        ? t(lang, 'profileAvatarRejectedNote')
        : null;

  // How others will see the player: the line every board draws. A board wears the placeholder
  // ink only for a STORED empty name — on an account, the field reading that account's own
  // pseudonym (the READ half), which a save stores as empty again. A TOKENLESS device's name
  // is dressed as a stored one: a deployed-unsaved account that was deployed from any other
  // button stores the placeholder the device was showing as its first profile
  // (`localIdentityDeploy`), and the two must show the same screen. THIS screen's SAVE is the
  // one deploy that bypasses that (`withoutLocalIdentityDeploy` in `onSave`): an UNTOUCHED
  // placeholder name stores as the empty name, so a tokenless player's first SAVE leaves them
  // wearing their new account's own pseudonym, in the placeholder ink.
  const anon = name === '' || (loadedFor !== null && name === anonName(loadedFor));
  // An emptied field shows what a board would print in its place: the assigned pseudonym, muted.
  const shownWhenEmpty = assignedFrom ? anonName(assignedFrom) : t(lang, 'profileNamePlaceholder');
  const empty = cells.every((value) => value === 0);
  const canSave = phase === 'idle' && dirty && tool === null;

  // THE PALETTES are ONE choice (a radio group): Tab lands on the one in hand, the arrows
  // choose — so the keyboard's brackets and the chosen swatch's corners frame the same tile.
  // (Their handlers are stable, reading the screen as it now stands, so the row stays memoized.)
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onSwatchKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    if (busy) return;
    const next = (index + step + AVATAR_PALETTES.length) % AVATAR_PALETTES.length;
    pickPalette(next);
    swatchRefs.current[next]?.focus();
  };
  const latestPick = useRef(pickPalette);
  latestPick.current = pickPalette;
  const latestKey = useRef(onSwatchKey);
  latestKey.current = onSwatchKey;
  const onPick = useCallback((index: number) => latestPick.current(index), []);
  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => latestKey.current(e, index),
    [],
  );

  return (
    <>
      {/* The way OUT: UP, to `/account` (#204's UX rework, 2026-08-26). This screen
          answers ONE question — how others see me — and `/account` is its only door. */}
      <HeaderLeft>
        <HeaderBack label={t(lang, 'ariaBack')} onBack={() => navigate(ACCOUNT_PATH)} />
        <LangTitle lang={lang} title={t(lang, 'profileTitle')} />
      </HeaderLeft>
      <div
        ref={screenRef}
        className={`profile-screen${cellPx > 0 ? ' measured' : ''}${layout.short ? ' short' : ''}`}
        style={
          {
            '--pcell': `${cellPx}px`,
            '--pside': `${canvasSide(cellPx)}px`,
            '--pframe-at': `${layout.frameAt}px`,
            '--pswatch-gap': `${layout.swatchGap}px`,
            '--pswatches-at': `${layout.swatchesAt}px`,
            ...(layout.column > 0 ? { '--pcolumn': `${layout.column}px` } : {}),
          } as React.CSSProperties
        }
      >
        {/* THE TOOL KEYS, over the canvas on its left edge: pixel marks in a tappable thing's
            corners, the one playing lit. Their row holds its place while the stored profile is
            read, so the canvas under it stands where it will from the first frame. */}
        <div className="profile-tools">
          {load === 'ready' && (
            <>
              <button
                type="button"
                className={`profile-key${tool === 'dice' ? ' busy' : ''}`}
                aria-label={t(lang, 'profileDice')}
                title={t(lang, 'profileDice')}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) roll();
                }}
              >
                <DiceIcon className="ui-icon" aria-hidden />
              </button>
              <button
                type="button"
                className={`profile-key${tool === 'clear' ? ' busy' : ''}`}
                aria-label={t(lang, 'profileClear')}
                title={t(lang, 'profileClear')}
                aria-disabled={busy || empty || undefined}
                onClick={() => {
                  if (!busy && !empty) clear();
                }}
              >
                <ClearIcon className="ui-icon" aria-hidden />
              </button>
            </>
          )}
        </div>

        {/* THE CANVAS, in the corner brackets of a thing that takes the finger — slate at
            rest, white while a stroke is down, LOCKING ON again when a save lands. Until the
            stored profile has answered, its box is the house's stippled slate, breathing while
            the read is out and still after one failed — under the mark handed over, frozen
            where it stood (below), it only comes in once the read has taken a beat (`.late`),
            so a quick answer grows straight out of the mark. */}
        <div ref={frameRef} className={`profile-frame${painting ? ' painting' : ''}`}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
            <i key={`${corner}${stamp}`} className={`profile-corner ${corner}${stamp ? ' lock' : ''}`} aria-hidden="true" />
          ))}
          <div ref={boxRef} className="profile-canvas-box">
            {load !== 'ready' ? (
              <StatSlot
                phase={load === 'failed' ? 'failed' : 'loading'}
                className={`profile-canvas-hold${load === 'loading' && handed ? ' late' : ''}`}
              />
            ) : (
              <div
                ref={canvasRef}
                className="avatar-editor"
                style={
                  grow
                    ? {
                        width: canvasSide(grow.cell),
                        height: canvasSide(grow.cell),
                        transform: `translate(${grow.x}px, ${grow.y}px)`,
                      }
                    : undefined
                }
                role="img"
                aria-label={t(lang, 'ariaAvatarEditor')}
                onPointerDown={saving ? undefined : onPointerDown}
                onPointerMove={saving ? undefined : onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                onPointerLeave={() => setHover(null)}
              >
                <EditorCanvas palette={palette} cells={shownCells} cell={drawnCell} fx={fx} hover={saving ? null : hover} />
                <DitherWipe shot={wipe} cellPx={drawnCell} />
                {/* The foil lies on the cells' own pitch (from the first inner pixel), so its
                    2px grain lands on every cell's edge. */}
                <span className="profile-foil">
                  <FoilStamp play={stamp} avatar={encoded} seed={foilSeed(`profile:${assignedFrom}`)} />
                </span>
              </div>
            )}
          </div>
        </div>

        {load === 'failed' && (
          <div className="profile-retry">
            <p className="sr-only" role="status">
              {t(lang, 'failedProfile')}
            </p>
            {/* The read that failed, asked again: the quiet word in a tappable thing's
                brackets — the still checker over the canvas already says "unknown". */}
            <button type="button" className="quiet-btn" onClick={() => setAttempt((n) => n + 1)}>
              {t(lang, 'retry')}
            </button>
          </div>
        )}

        {load === 'ready' && (
          <>
            <Swatches
              lang={lang}
              palette={palette}
              cells={shownPreview}
              busy={busy}
              onPick={onPick}
              onKey={onKey}
              refs={swatchRefs}
            />

            {/* HOW OTHERS SEE ME, shown: the line every board draws for this player — the mark
                at the boards' size, the NAME TYPED ON IT in the boards' dress — and nothing a
                board would only say once they have played (no rank, no crown, no count). Its
                mark takes a new palette once the canvas's sweep has passed, and a rolled shape
                once it has landed. */}
            <div className="profile-line">
              <LineMark key={`hop${stamp}`} avatar={encodeAvatar(linePalette ?? palette, shownPreview)} stamp={stamp} />
              <input
                ref={nameRef}
                className={`profile-name${anon ? ' anon' : ''}${refused === 'name_rejected' ? ' refused' : ''}${
                  nameShake ? ' invalid' : ''
                }`}
                type="text"
                value={name}
                readOnly={saving}
                maxLength={NAME_MAX_LENGTH}
                placeholder={shownWhenEmpty}
                aria-label={t(lang, 'profileNamePlaceholder')}
                aria-invalid={refused === 'name_rejected' || undefined}
                aria-describedby={refusalNote !== null ? refusalId : undefined}
                onAnimationEnd={() => setNameShake(false)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  applyName(e.currentTarget.value, e.currentTarget.selectionStart);
                }}
                onChange={(e) => {
                  if (composingRef.current) setName(e.target.value);
                  else applyName(e.target.value, e.target.selectionStart);
                  // A refused name stands until it is edited; a refused drawing, until the
                  // drawing is.
                  setRefused((held) => (held === 'avatar_rejected' ? held : null));
                }}
              />
              {/* A moderation refusal's ONE note, under the name's line on the air above SAVE
                  (out of the flow: nothing moves when it speaks). A live region that exists
                  before it does. */}
              <p id={refusalId} className="account-note danger profile-refusal" role="status">
                {refusalNote}
              </p>
            </div>

            {/* Nothing to save = unavailable — the board itself says whether there is a
                change. While saving, the label rolls out the bottom and the dot loader drops
                in from the top; the restore beat rolls the label back up — and a save that
                landed STAMPS the canvas in foil. */}
            <button
              type="button"
              className={`mix-btn profile-save${phase !== 'idle' ? ` ${phase}` : ''}`}
              aria-disabled={!canSave || undefined}
              aria-busy={phase === 'saving'}
              onClick={() => {
                if (canSave) void onSave();
              }}
            >
              <span
                className={`save-label${phase === 'saving' ? ' out' : phase === 'restoring' ? ' back' : ''}`}
              >
                {t(lang, 'profileSave')}
              </span>
              {phase !== 'idle' && (
                <span
                  className={`save-dots${phase === 'restoring' ? ' out' : ''}`}
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </button>
            {/* The save's failure, on the app's error surface (#216 rework). */}
            {saveError && (
              <ErrorScreen
                lang={lang}
                title={saveError.title}
                note={saveError.note}
                onClose={() => setRefused(null)}
              />
            )}
          </>
        )}
      </div>
      {/* The mark handed over by the masthead, FROZEN where it stood while the stored profile
          is read — the canvas grows out of this very box once it has answered. */}
      {load === 'loading' && handed && (
        <span
          className="profile-handed"
          style={{
            left: Math.round(handed.rect.left),
            top: Math.round(handed.rect.top),
            width: Math.round(handed.rect.width),
            height: Math.round(handed.rect.height),
          }}
          aria-hidden="true"
        >
          {handed.avatar ? (
            <Avatar avatar={handed.avatar} size={Math.round(handed.rect.width)} sharp />
          ) : (
            <StatSlot phase="loading" />
          )}
        </span>
      )}
    </>
  );
}
