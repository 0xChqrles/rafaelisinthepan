import { codeOf, keysBeats, type KeyChange, type KeysBeats, type KeysModel, type KeysSpec } from './keysScene';
import { drawnOf, isBuilt, isStamped, markBuilt, markStamped, rememberDrawn, type DrawnCode } from './memory';

// WHICH SCENE the month raster plays next, off the one on screen before it (`MonthRaster`
// latches one per change of what it shows). A month shown for the first time today ARRIVES
// (built once per day and account, the memory's BUILT) — at the opening's pace, or under a
// turn's quicker one — and today DROPS once per day (STAMPED); a month already built stands
// SETTLED, and any day that says something else than when it was last DRAWN plays its change.
// A fresh answer for the month on screen plays what it changes — unless the month is still
// ARRIVING: then it JOINS the arrival (the same build, the same drop, on the arrival's own
// clock), so a month that arrives goes on arriving. A ceremony plays ONCE: all three memories
// are written as a stage is SHOWN (`markShown`), so a player who leaves halfway through one
// does not see it again.
//
// HOW IT GIVES WAY (`MonthRaster` composes it): a turn, from the frame on screen cell by cell
// (the podium's `turnLevel`); a read landing on the month on screen, KEY BY KEY — the scene
// before plays on under each key's cells not lit yet (the loading checker and its wave, a turn
// still finishing), though nothing in it that had not begun to come in by then ever does — as
// does a changed day. Reduced motion has no arrival and no give: the landed frame, marked
// built and stamped as it is shown.

// What a scene shows: the month, the active game day it is shown on, and what its days say.
export interface Shown {
  month: string;
  activeDay: number;
  model: KeysModel;
  // The grid's dates (null: a pad), the cells the model describes.
  cells: readonly (string | null)[];
}

// Who it is shown to, and how.
export interface Viewer {
  lang: string;
  accountId: string | null;
  motion: boolean;
}

export interface Stage extends Shown {
  // Its identity: what it shows, to whom — a new one is a new scene.
  id: string;
  spec: KeysSpec;
  beats: KeysBeats;
  // How it gives way from the frame on screen: the whole raster (a turn), key by key (a read
  // landing, a change), or not at all (the first frame).
  give: 'turn' | 'keys' | null;
  // What showing it settles in the memory: the month built, today dropped.
  marks: { built: boolean; stamped: boolean };
  // It goes on along the clock of the stage it replaces (a fresh answer joining an arrival).
  carries: boolean;
}

export function stageId(next: Shown, viewer: Viewer): string {
  // A day by its kind's first two letters (`no`, `ov`, `ou`, `un`, `so`, `pa`: all distinct),
  // a % by its value.
  const days = next.model.keys.map((key) => (key.kind === 'progress' ? `p${key.pct}` : key.kind.slice(0, 2))).join(',');
  return `${viewer.lang}|${viewer.accountId ?? '-'}|${viewer.motion ? 'm' : 'r'}|${next.month}|${next.activeDay}|${next.model.phase}|${next.model.today}|${days}`;
}

// A month's readings by date, as the DRAWN memory keeps them.
export function codesOf(model: KeysModel, cells: readonly (string | null)[]): Map<string, DrawnCode> {
  const codes = new Map<string, DrawnCode>();
  model.keys.forEach((key, i) => {
    const date = cells[i];
    const code = codeOf(key);
    if (date && code) codes.set(date, code);
  });
  return codes;
}

// The days that read differently from `was`.
function changesFrom(next: Shown, was: ReadonlyMap<string, DrawnCode>): KeyChange[] {
  const changes: KeyChange[] = [];
  next.model.keys.forEach((key, i) => {
    const date = next.cells[i];
    const code = codeOf(key);
    const from = date ? was.get(date) : undefined;
    if (code && from && from !== code) changes.push({ index: i, from });
  });
  return changes;
}

// `arriving`: the stage on screen is an arrival whose scene has not settled yet.
export function nextStage(prev: Stage | null, next: Shown, viewer: Viewer, arriving = false): Stage {
  const { model, month, activeDay } = next;
  const { lang, accountId, motion } = viewer;
  const same = prev !== null && prev.month === month;
  const base: KeysSpec = { model, build: null, drop: null, changes: [], digitsIn: false, ghostsIn: false, motion };
  const stage = (
    spec: KeysSpec,
    give: Stage['give'],
    marks = { built: false, stamped: false },
    carries = false,
  ): Stage => ({
    ...next,
    id: stageId(next, viewer),
    spec,
    beats: keysBeats(spec),
    give: motion ? give : null,
    marks,
    carries,
  });
  if (!motion) {
    const marks = { built: model.phase === 'data', stamped: model.phase === 'data' && model.today >= 0 };
    return stage(base, null, marks);
  }
  if (model.phase !== 'data') {
    // The numbers come in at the screen's opening; a turn brings them in with it. The ghosts
    // wait the skeleton's wait, unless they already stand (a failed read asked again, a read
    // failing while they stood).
    const standing = same && prev.model.phase !== 'data';
    return stage({ ...base, digitsIn: prev === null, ghostsIn: !standing }, prev === null ? null : 'turn');
  }
  const today = model.today;
  const stampNow = today >= 0 && !isStamped(lang, activeDay);
  // THE FLIP: the same month across 22:00 — everything stands, the new today drops at once.
  if (same && prev.model.phase === 'data' && prev.activeDay !== activeDay) {
    return stage(
      { ...base, drop: stampNow ? 'flip' : null, changes: changesFrom(next, codesOf(prev.model, prev.cells)) },
      'keys',
      { built: true, stamped: stampNow },
    );
  }
  // A fresh answer for the month on screen: still arriving, it joins the arrival; else what it
  // says now against what the frame on screen was drawn saying.
  if (same && prev.model.phase === 'data') {
    if (arriving) return stage({ ...base, build: prev.spec.build, drop: prev.spec.drop }, null, prev.marks, true);
    return stage({ ...base, changes: changesFrom(next, codesOf(prev.model, prev.cells)) }, 'keys');
  }
  // A read landing on the month on screen, or a month turned to, or the screen's opening.
  const give: Stage['give'] = same ? 'keys' : prev === null ? null : 'turn';
  if (!isBuilt(activeDay, accountId, lang, month)) {
    const build = same || prev === null ? 'arrive' : 'turn';
    return stage({ ...base, build, drop: stampNow ? 'build' : null }, give, { built: true, stamped: stampNow });
  }
  const drawn = drawnOf(accountId, lang, month);
  return stage({ ...base, changes: drawn ? changesFrom(next, drawn) : [] }, give);
}

// What showing a stage settles in the memory, written as it is shown: the month BUILT, today
// STAMPED, and — a month with data — what its days say, DRAWN.
export function markShown(stage: Stage, viewer: Viewer): void {
  if (stage.marks.built) markBuilt(stage.activeDay, viewer.accountId, viewer.lang, stage.month);
  if (stage.marks.stamped) markStamped(viewer.lang, stage.activeDay);
  if (stage.model.phase === 'data') {
    rememberDrawn(viewer.accountId, viewer.lang, stage.month, codesOf(stage.model, stage.cells));
  }
}
