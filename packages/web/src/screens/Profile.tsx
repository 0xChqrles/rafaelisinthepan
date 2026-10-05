import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { ACCOUNT_PATH } from '../langs';
import useUiLang from '../hooks/useUiLang';
import { t } from '../i18n';
import Avatar from '../components/Avatar';
import { MARK } from '../components/boardMetrics';
import DitherWipe, { type WipeShot } from '../components/editor/DitherWipe';
import {
  cellLine,
  churnCells,
  drainStep,
  isSymmetric,
  landingOrder,
  paintStroke,
  rollShape,
} from '../components/editor/tools';
import { foilSeed } from '../components/foil';
import FoilStamp from '../components/FoilStamp';
import { takeMark } from '../components/markHandoff';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import LangTitle from '../components/LangTitle';
import { HeaderBack, HeaderLeft } from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
import { prefersReducedMotion } from '../hooks/useScramble';
import PencilIcon from '../assets/icons/pencil.svg?react';
import MirrorIcon from '../assets/icons/mirror.svg?react';
import DiceIcon from '../assets/icons/dice.svg?react';
import ClearIcon from '../assets/icons/clear.svg?react';

// The #188 profile editor — `/account`'s masthead OPENED: the mark the player tapped GROWS
// out of its own box into the CANVAS (`markHandoff`), in the corner brackets of a thing that
// takes the finger, over the name typed in place in its WHITE CHIP. Under it the palettes —
// each swatch the drawing itself in that palette ({bg, fg} pairs, user-decided 2026-08-19:
// two colours, nothing else, so picking a ground picks the ink with it) — and the three
// tools: MIRROR (paint a cell and its twin; the assigned marks are mirrored, so it opens ON
// for a symmetric drawing), DICE (a new SHAPE the assigned way, the palette kept), CLEAR (the
// drawing drained in the Bayer order). Then the line every board will draw for the player —
// how others see them, shown rather than said — and SAVE on the bottom edge, whose landing
// is the screen's one shiny thing: the FOIL STAMP. Every tool is an ordinary edit; SAVE is
// the deploy.
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
// first); nothing was created and nothing was saved, and TRY AGAIN re-runs the whole tap.
type SaveRefusal = 'name_rejected' | 'avatar_rejected' | 'account' | 'error' | null;

// The loader holds at least this long even on an instant answer — a flash of dots
// reads as a glitch — and the restore beat covers the label's roll-back animation.
const SAVE_DOTS_MIN_MS = 750;
const SAVE_RESTORE_MS = 240;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- THE CANVAS'S GEOMETRY (visual only: nothing here decides what is saved). Its cell is a
// WHOLE, EVEN number of px — the house's 2px dither lands on the cells' own edges — the
// largest the column holds inside the card, and the largest that leaves the whole editor on
// a phone's screen with nothing scrolled (an iPhone SE's 667px included): the chrome around
// the canvas (the bar's clearance, the card's frame and chip, the tools, the board line,
// SAVE on the edge) is EDITOR_CHROME_PX of the height, the CSS's own sum.
const CELL_MIN = 20;
const CELL_MAX = 36;
const CARD_PAD_PX = 14;
const EDITOR_CHROME_PX = 334;
// The canvas grows out of the masthead's mark in whole-pixel steps, a cell this much bigger
// each step, a step this long.
const GROW_CELL_STEP = 4;
const GROW_STEP_MS = 50;
// The masthead's mark when nothing hands it over (a direct load): the growth starts here,
// from the canvas's centre.
const GROW_FROM_CELL = 5;
// The dice: a churn, then the new shape landing out of it cell by cell, at the churning
// tile's 16-ish fps; CLEAR: the Bayer drain, in hard steps.
const DICE_FRAME_MS = 60;
const DICE_CHURN_MS = 360;
const DICE_LAND_MS = 360;
const CLEAR_STEPS = 6;
const CLEAR_STEP_MS = 50;
// A refused save SHAKES the card, in whole pixels, a step a frame.
const REFUSE_SHAKE: readonly (readonly [number, number])[] = [
  [-4, 0],
  [4, 0],
  [-2, 0],
  [2, 0],
];
const REFUSE_SHAKE_FRAME_MS = 50;

// A cell's pop: how many times it has changed under a tool, and which way the last change
// went — ink IN (it pops proud and throws its sparks) or OUT (it shrinks into its middle).
interface Bump {
  n: number;
  kind: 'in' | 'out';
}
const bumped = (b: Record<number, Bump>, changed: readonly number[], kind: Bump['kind']) => {
  if (changed.length === 0) return b;
  const next = { ...b };
  for (const i of changed) next[i] = { n: (next[i]?.n ?? 0) + 1, kind };
  return next;
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
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [refused, setRefused] = useState<SaveRefusal>(null);
  // Per-cell paint counters: a painted cell remounts keyed on its count, replaying its pop —
  // and ONLY a painted one, so loading a stored drawing pops nothing. The pop's KIND (ink in,
  // ink out) rides with the count.
  const [bumps, setBumps] = useState<Record<number, Bump>>({});
  // What the server holds (or the blank start before any save): SAVE only lights up
  // when the editor differs from it, and a successful save re-baselines.
  const [baseline, setBaseline] = useState(() => ({ name: '', avatar: blankAvatar() }));
  const [load, setLoad] = useState<LoadState>('loading');
  // Bumped by RETRY — re-runs the read the way usePuzzle's retry re-runs its fetch.
  const [attempt, setAttempt] = useState(0);

  // ---- the TOOLS (each an ordinary edit; SAVE stays the deploy). MIRROR opens ON for a
  // left-right symmetric drawing — every assigned mark is one — and OFF for a drawing made
  // lopsided on purpose. DICE and CLEAR PLAY (a churn, a drain), and while one plays the canvas
  // takes no paint and the other tools wait.
  const [mirror, setMirror] = useState(true);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const [tool, setTool] = useState<'dice' | 'clear' | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // The dice's churn, shown over the drawing while it rolls (the palette never changes).
  const [churn, setChurn] = useState<number[] | null>(null);
  const toolTimers = useRef<number[]>([]);
  useEffect(() => () => toolTimers.current.forEach((id) => window.clearTimeout(id)), []);

  // ---- the canvas's drawing (visual only).
  const screenRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(0);
  // What the canvas WAS, swept off it through the dither on a palette switch.
  const [wipe, setWipe] = useState<WipeShot | null>(null);
  const wipeKey = useRef(0);
  // Bumped by a save that LANDED (the stamp), and by one REFUSED (the shake).
  const [stamp, setStamp] = useState(0);
  const [refusedShake, setRefusedShake] = useState(0);
  // Where the name's caret stands while the field holds the focus (null: it does not).
  const [caret, setCaret] = useState<{ at: number; range: boolean } | null>(null);

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
    setCells(decoded.cells);
    setMirror(isSymmetric(decoded.cells));
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
  // last cell the finger crossed (`cellLine`), so a fast drag leaves no gap; with MIRROR on,
  // every cell's twin takes the stroke too. The cell is read off the pointer's place on the
  // canvas, never off the element under it: the canvas wears overlays (the sweep, the foil)
  // and grows in under a transform.
  const strokeRef = useRef<0 | 1 | null>(null);
  const lastRef = useRef<number | null>(null);
  const cellAt = useCallback((x: number, y: number): number | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return null;
    const cx = Math.floor(((x - box.left) / box.width) * AVATAR_SIZE);
    const cy = Math.floor(((y - box.top) / box.height) * AVATAR_SIZE);
    if (cx < 0 || cy < 0 || cx >= AVATAR_SIZE || cy >= AVATAR_SIZE) return null;
    return cy * AVATAR_SIZE + cx;
  }, []);
  const paintTo = useCallback((index: number | null) => {
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
    const path = from === null ? [index] : cellLine(from, index);
    setCells((prev) => {
      const { cells: next, changed } = paintStroke(prev, path, stroke, mirrorRef.current);
      if (changed.length === 0) return prev;
      setBumps((b) => bumped(b, changed, stroke === 1 ? 'in' : 'out'));
      return next;
    });
    setRefused(null);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (toolRef.current !== null) return;
      const index = cellAt(e.clientX, e.clientY);
      if (index === null) return;
      strokeRef.current = cells[index] === 1 ? 0 : 1;
      lastRef.current = null;
      e.currentTarget.setPointerCapture(e.pointerId);
      paintTo(index);
    },
    [cells, cellAt, paintTo],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (strokeRef.current === null) return;
      // A fast drag's skipped samples (coalesced events) are walked too.
      const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
      for (const sample of events.length > 0 ? events : [e.nativeEvent]) paintTo(cellAt(sample.clientX, sample.clientY));
    },
    [cellAt, paintTo],
  );
  const endStroke = useCallback(() => {
    strokeRef.current = null;
    lastRef.current = null;
  }, []);

  // DICE: the tile CHURNS on the waiting tile's noise (every frame a plausible creature, in
  // the palette already chosen), then the new shape LANDS out of it cell by cell, and the
  // landed shape is the edit.
  const roll = useCallback(() => {
    const target = rollShape(cells);
    const commit = () => {
      setChurn(null);
      setTool(null);
      setCells((prev) => {
        const on = target.flatMap((v, i) => (v === 1 && prev[i] !== 1 ? [i] : []));
        const off = target.flatMap((v, i) => (v === 0 && prev[i] === 1 ? [i] : []));
        setBumps((b) => bumped(bumped(b, on, 'in'), off, 'out'));
        return target;
      });
      setRefused(null);
    };
    if (prefersReducedMotion()) {
      commit();
      return;
    }
    setTool('dice');
    const order = landingOrder(target);
    const landAt = new Array<number>(AVATAR_CELLS);
    order.forEach((index, n) => {
      landAt[index] = DICE_CHURN_MS + (n / (order.length - 1)) * DICE_LAND_MS;
    });
    const frames = Math.ceil((DICE_CHURN_MS + DICE_LAND_MS) / DICE_FRAME_MS);
    const offset = Math.floor(Math.random() * 1000);
    for (let f = 0; f <= frames; f += 1) {
      const at = f * DICE_FRAME_MS;
      toolTimers.current.push(
        window.setTimeout(() => {
          if (f === frames) {
            commit();
            return;
          }
          const noise = churnCells(offset + f);
          setChurn(noise.map((v, i) => (at >= landAt[i] ? target[i] : v)));
        }, at),
      );
    }
  }, [cells]);

  // CLEAR: the drawing DRAINS — its cells go out in the Bayer order, in hard steps, each with
  // its own small shrink.
  const clear = useCallback(() => {
    if (prefersReducedMotion()) {
      setCells(new Array<number>(AVATAR_CELLS).fill(0));
      setRefused(null);
      return;
    }
    setTool('clear');
    for (let step = 1; step <= CLEAR_STEPS; step += 1) {
      toolTimers.current.push(
        window.setTimeout(() => {
          setCells((prev) => {
            const { cells: next, gone } = drainStep(prev, step, CLEAR_STEPS);
            if (gone.length === 0) return prev;
            setBumps((b) => bumped(b, gone, 'out'));
            return next;
          });
          if (step === CLEAR_STEPS) {
            setTool(null);
            setRefused(null);
          }
        }, step * CLEAR_STEP_MS),
      );
    }
  }, []);

  const pickPalette = (index: number) => {
    if (index === palette) return;
    wipeKey.current += 1;
    setWipe({ palette, cells: churn ?? cells, key: wipeKey.current });
    setPalette(index);
    setRefused(null);
  };

  // The editor is FROZEN while a save runs (its two round trips can take real time on a
  // phone, and the GUARDED success path re-binds every field to the merged server truth):
  // an edit made mid-save would be silently replayed over when the answer lands — the grid
  // visibly snapping back, SAVE greying out as though the change had been stored.
  const saving = phase !== 'idle';
  // One encode per render, shared by the preview, the dirty check and the save body.
  const encoded = encodeAvatar(palette, cells);
  // No trim on either side: the rule has no room for whitespace at all (it sanitizes
  // to `_`), the baseline is sanitized on load, and the SERVER stores the body it is
  // sent verbatim — so the two strings compared here are the same two strings the
  // route holds, and the re-baseline below is exact.
  const dirty = name !== baseline.name || encoded !== baseline.avatar;
  // What the canvas SHOWS: the drawing, or the dice's churn over it while it rolls — the
  // canvas, the swatches and the board line follow it.
  const shownCells = churn ?? cells;
  const shownEncoded = churn ? encodeAvatar(palette, churn) : encoded;

  // THE CANVAS'S CELL, off the column's width and the window's height (see EDITOR_CHROME_PX).
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return undefined;
    const measure = () => {
      const room = screen.clientWidth - 2 * CARD_PAD_PX;
      const byWidth = room / AVATAR_SIZE;
      const byHeight = (window.innerHeight - EDITOR_CHROME_PX) / AVATAR_SIZE;
      const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, 2 * Math.floor(Math.min(byWidth, byHeight) / 2)));
      setCellPx((prev) => (prev === cell ? prev : cell));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(screen);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [load]);

  // THE CANVAS GROWS OUT OF THE MASTHEAD'S MARK as the editor opens: from the mark's own cell
  // up to the canvas's, GROW_CELL_STEP px a cell a step — whole pixels at every step, nothing
  // in between — and, opened from the masthead, out of the very box the mark stood in
  // (`markHandoff`), travelling to its place on whole pixels as it grows. A direct load, or a
  // note that is stale (off the screen, the wrong size), grows from the canvas's own centre.
  const grown = useRef(false);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el || cellPx <= 0 || grown.current) return;
    grown.current = true;
    const handed = takeMark();
    if (prefersReducedMotion() || typeof el.animate !== 'function') return;
    const side = cellPx * AVATAR_SIZE;
    const at = el.getBoundingClientRect();
    const usable =
      handed !== null &&
      handed.width >= 20 &&
      handed.width <= 120 &&
      Math.abs(handed.width - handed.height) < 1 &&
      handed.bottom > 0 &&
      handed.top < window.innerHeight &&
      handed.right > 0 &&
      handed.left < window.innerWidth;
    const fromCell = usable ? Math.max(1, Math.round(handed.width / AVATAR_SIZE)) : GROW_FROM_CELL;
    const fromSide = fromCell * AVATAR_SIZE;
    const fromX = usable ? handed.left - at.left : (side - fromSide) / 2;
    const fromY = usable ? handed.top - at.top : (side - fromSide) / 2;
    const sizes: number[] = [];
    for (let size = fromCell; size < cellPx; size += GROW_CELL_STEP) sizes.push(size);
    sizes.push(cellPx);
    if (sizes.length < 2) return;
    const last = sizes.length - 1;
    el.animate(
      sizes.map((size, k) => {
        const left = 1 - k / last;
        return {
          transformOrigin: '0 0',
          transform: `translate(${Math.round(fromX * left)}px, ${Math.round(fromY * left)}px) scale(${size / cellPx})`,
          offset: k / last,
          easing: 'steps(1, end)',
        };
      }),
      { duration: GROW_STEP_MS * last },
    );
  }, [cellPx]);

  // A REFUSED save shakes the card, in whole pixels (the ErrorScreen then says why).
  useEffect(() => {
    const card = cardRef.current;
    if (refusedShake === 0 || !card || prefersReducedMotion() || typeof card.animate !== 'function') return;
    const frames: Keyframe[] = REFUSE_SHAKE.map(([dx, dy], k) => ({
      translate: `${dx}px ${dy}px`,
      offset: k / REFUSE_SHAKE.length,
      easing: 'steps(1, end)',
    }));
    frames.push({ translate: '0 0', offset: 1 });
    card.animate(frames, { duration: REFUSE_SHAKE.length * REFUSE_SHAKE_FRAME_MS });
  }, [refusedShake]);

  // The caret follows the field's own selection.
  const syncCaret = useCallback(() => {
    const input = nameRef.current;
    if (!input || document.activeElement !== input) {
      setCaret(null);
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    setCaret((prev) =>
      prev && prev.at === start && prev.range === (start !== end) ? prev : { at: start, range: start !== end },
    );
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', syncCaret);
    return () => document.removeEventListener('selectionchange', syncCaret);
  }, [syncCaret]);
  useLayoutEffect(() => {
    if (caret !== null) syncCaret();
    // (Re-read on every new name: the sanitizer may have moved the caret.)
  }, [name]);

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
    // The landing, told on the canvas (visual only): a save that LANDED is stamped in foil, a
    // refused one shakes the card.
    if (written && outcome === null) setStamp((n) => n + 1);
    else if (outcome !== null) setRefusedShake((n) => n + 1);
    setPhase('restoring');
    await sleep(SAVE_RESTORE_MS);
    if (epoch !== null && identityEpoch() !== epoch) return;
    setPhase((held) => (held === 'restoring' ? 'idle' : held));
  }, [name, encoded, assignedFrom, baseline, loadedFor]);

  // What the error surface says for each outcome (#216 rework, replacing the inline
  // status line): the moderation refusals explain themselves and offer no retry — asking
  // again with the same value cannot help — while a transport failure and a failed deploy
  // both carry TRY AGAIN, which re-runs the whole single-tap save.
  const saveError =
    refused === 'name_rejected'
      ? { title: t(lang, 'profileNameRejected'), note: t(lang, 'profileNameRejectedNote') }
      : refused === 'avatar_rejected'
        ? { title: t(lang, 'profileAvatarRejected'), note: t(lang, 'profileAvatarRejectedNote') }
        : refused === 'account'
          ? { title: t(lang, 'failedAccount'), note: t(lang, 'failedAccountNote') }
          : refused === 'error'
            ? { title: t(lang, 'profileSaveFailed'), note: t(lang, 'failedSaveNote') }
            : null;

  // How others will see the player: the line every board draws — and a name still the
  // assigned pseudonym (or none) is dressed in the placeholder ink there, so it is here too.
  const anon = name === '' || (assignedFrom !== '' && name === anonName(assignedFrom));
  const lineName = name || (assignedFrom ? anonName(assignedFrom) : '');
  const empty = cells.every((value) => value === 0);
  const busy = saving || tool !== null;

  return (
    <>
      {/* The way OUT: UP, to `/account` (#204's UX rework, 2026-08-26). This screen
          answers ONE question — how others see me — and `/account` is its only door. */}
      <HeaderLeft>
        <HeaderBack label={t(lang, 'ariaBack')} onBack={() => navigate(ACCOUNT_PATH)} />
        <LangTitle lang={lang} title={t(lang, 'profileTitle')} />
      </HeaderLeft>
      {load === 'loading' && (
        <p className="status">
          <LoadingWave text={t(lang, 'loading')} />
        </p>
      )}
      {load === 'failed' && (
        <LoadError
          message={t(lang, 'failedProfile')}
          lang={lang}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {load === 'ready' && (
        <div
          ref={screenRef}
          className={`profile-screen${cellPx > 0 ? ' measured' : ''}`}
          style={{ '--pcell': `${cellPx}px` } as React.CSSProperties}
        >
          {/* THE CARD, OPENED: the masthead's mark become the canvas, over the name in its
              white chip — inside the corner brackets of a thing that takes the finger. A save
              that lands re-keys the brackets, so they lock on again. */}
          <div ref={cardRef} className="profile-card">
            {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
              <i key={`${corner}${stamp}`} className={`profile-corner ${corner}${stamp ? ' lock' : ''}`} aria-hidden="true" />
            ))}
            <div className="profile-canvas-box">
              {/* The MIRROR's axis, said at the canvas's edges only — never a line over the
                  drawing. */}
              {mirror && (
                <>
                  <i className="profile-axis top" aria-hidden="true" />
                  <i className="profile-axis bottom" aria-hidden="true" />
                </>
              )}
              {/* The palette's two inks are the canvas's only variables: an EMPTY cell wears
                  the ground with a speck of the ink in its corner — where the grid is — and a
                  painted one the ink. One mark, continuous: no gutters, no lines. */}
              <div
                ref={canvasRef}
                className={`avatar-editor${tool === 'dice' ? ' rolling' : ''}`}
                style={
                  {
                    '--cell-bg': AVATAR_PALETTES[palette].bg,
                    '--cell-fg': AVATAR_PALETTES[palette].fg,
                  } as React.CSSProperties
                }
                role="img"
                aria-label={t(lang, 'ariaAvatarEditor')}
                onPointerDown={saving ? undefined : onPointerDown}
                onPointerMove={saving ? undefined : onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
              >
                {shownCells.map((value, i) => {
                  const bump = churn ? undefined : bumps[i];
                  return (
                    <div
                      // The paint counter in the key remounts a changed cell, replaying its
                      // pop (and its sparks, when it took the ink); the position keeps the
                      // identity.
                      key={`${i}:${bump?.n ?? 0}`}
                      className={`avatar-editor-cell${value === 1 ? ' on' : ''}${
                        bump ? (bump.kind === 'in' ? ' painted' : ' erased') : ''
                      }`}
                    />
                  );
                })}
                <DitherWipe shot={wipe} cellPx={cellPx} />
                <FoilStamp play={stamp} avatar={encoded} seed={foilSeed(`profile:${assignedFrom}`)} />
              </div>
            </div>
            {/* THE NAME, edited in place in the white chip: the field IS the chip, exactly as
                wide as what it holds (the mono's fixed advance); the house's caret — the
                prompt's, in the accent — stands where the text cursor is; the pencil beside the
                chip says it can be typed into, until it is. */}
            <span
              className="profile-name-chip"
              style={{ '--n': Math.max(1, name.length || t(lang, 'profileNamePlaceholder').length) } as React.CSSProperties}
            >
              <input
                ref={nameRef}
                className="profile-name"
                type="text"
                value={name}
                readOnly={saving}
                maxLength={NAME_MAX_LENGTH}
                placeholder={t(lang, 'profileNamePlaceholder')}
                aria-label={t(lang, 'profileNamePlaceholder')}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onFocus={syncCaret}
                onBlur={() => setCaret(null)}
                onSelect={syncCaret}
                onKeyUp={syncCaret}
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
                  setRefused(null);
                }}
              />
              {caret !== null && !caret.range && !saving && (
                <span
                  key={`${caret.at}:${name}`}
                  className="profile-caret"
                  style={{ '--at': caret.at } as React.CSSProperties}
                  aria-hidden="true"
                />
              )}
              <span className={`profile-name-pen${caret !== null ? ' off' : ''}`} aria-hidden="true">
                <PencilIcon className="ui-icon" />
              </span>
            </span>
          </div>

          {/* THE PALETTES and THE TOOLS, one row. A swatch is the drawing itself, worn in that
              palette — a preview of the choice, not a chip of colour — and only the one in
              hand wears the white corners. The tools are pixel marks in a tappable thing's
              corners; MIRROR on is the white chip. */}
          <div className="profile-tools">
            <div className="profile-palettes">
              {AVATAR_PALETTES.map((option, index) => (
                <button
                  key={option.name}
                  type="button"
                  className={`profile-swatch${palette === index ? ' sel' : ''}`}
                  style={{ '--i': index } as React.CSSProperties}
                  aria-label={`${t(lang, 'ariaPalette')} ${option.name}`}
                  aria-pressed={palette === index}
                  disabled={busy}
                  onClick={() => pickPalette(index)}
                >
                  <Avatar avatar={encodeAvatar(index, shownCells)} size={30} sharp />
                </button>
              ))}
            </div>
            <div className="profile-keys">
              <button
                type="button"
                className={`profile-key${mirror ? ' on' : ''}`}
                aria-pressed={mirror}
                aria-label={t(lang, 'profileMirror')}
                title={t(lang, 'profileMirror')}
                disabled={saving}
                onClick={() => setMirror((on) => !on)}
              >
                <MirrorIcon className="ui-icon" aria-hidden />
              </button>
              <button
                type="button"
                className={`profile-key${tool === 'dice' ? ' on' : ''}`}
                aria-label={t(lang, 'profileDice')}
                title={t(lang, 'profileDice')}
                disabled={busy}
                onClick={roll}
              >
                <DiceIcon className="ui-icon" aria-hidden />
              </button>
              <button
                type="button"
                className={`profile-key${tool === 'clear' ? ' on' : ''}`}
                aria-label={t(lang, 'profileClear')}
                title={t(lang, 'profileClear')}
                disabled={busy || empty}
                onClick={clear}
              >
                <ClearIcon className="ui-icon" aria-hidden />
              </button>
            </div>
          </div>

          {/* HOW OTHERS SEE ME, shown: the line every board draws for this player — the mark
              at the boards' size, the name in their dress — and nothing a board would only
              say once they have played (no rank, no crown, no count). */}
          <div className="profile-line" aria-hidden="true">
            <span key={`hop${stamp}`} className={`profile-line-mark${stamp ? ' hop' : ''}`}>
              <Avatar avatar={shownEncoded} size={MARK} sharp />
            </span>
            <span className={`board-name${anon ? ' anon' : ''}`}>{lineName}</span>
          </div>

          {/* Nothing to save = disabled — the board itself says whether there is a change.
              While saving, the label rolls out the bottom and the dot loader drops in from the
              top; the restore beat rolls the label back up — and a save that landed STAMPS the
              canvas in foil. */}
          <button
            type="button"
            className={`mix-btn profile-save${phase !== 'idle' ? ` ${phase}` : ''}`}
            disabled={phase !== 'idle' || !dirty || tool !== null}
            aria-busy={phase === 'saving'}
            onClick={onSave}
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
        </div>
      )}
    </>
  );
}
