// CONTRACT (the hole history modal, which replaced the #117 route map on 2026-08-10 and
// took the map's JOURNEY spine back on review the same day): the modal draws the round's
// counted tries as stops on one line toward the hidden word —
//   - the START word is a stop (identified by its stated rank, flagged `start`);
//   - every ranked try is a stop showing the form the player TYPED; a try beyond the map
//     is a miss, off the line entirely;
//   - "you are here" is the HOLE's current rank, never inferred from the log;
//   - the secret censors to null until the hole is solved (the `???` terminus), and the
//     solving guess is the terminus, never a stop;
//   - a stop FARTHER than the departure is flagged `behind` — the journey runs
//     departure → word, so a backwards guess is a stop but not a step of the walk;
//   - SOLVING names the whole walked stretch (departure → word), flagging what the player
//     never reached as `revealed`; a live hole names nothing it has not been to;
//   - what stays retired: no roads, no censored census while the round is LIVE.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { RankEntry, RuntimeHole } from '@whippin/shared';
import { buildHistory } from './history';

const RANKS: Record<string, RankEntry> = {
  foret: { word: 'forêt', rank: 0 },
  bois: { word: 'bois', rank: 1, dq: 255 },
  arbre: { word: 'arbre', rank: 3, dq: 200 },
  arbres: { word: 'arbre', rank: 3, dq: 200 }, // alias: same group, same rank
  branche: { word: 'branche', rank: 40, dq: 120 },
  prairie: { word: 'prairie', rank: 87, dq: 90 }, // the departure
  fleur: { word: 'fleur', rank: 812, dq: 12 },
};

const hole = (rank: number): RuntimeHole => ({
  pos: 0,
  secret: 'foret',
  word: 'prairie',
  rank,
  startRank: 87,
});

const build = (tried: string[], holeRank = 87) =>
  buildHistory({ rankMap: RANKS, tried, hole: hole(holeRank), startRank: 87, secretWord: 'forêt' });

describe('buildHistory', () => {
  it('an untouched hole is already a journey: the departure, and the censored target', () => {
    const model = build([]);
    expect(model.secret).toBeNull(); // `???` — the unknown the line is walked toward
    expect(model.stops).toEqual([
      { rank: 87, dq: 90, word: 'prairie', start: true, best: true, behind: false, revealed: false },
    ]);
    expect(model.misses).toEqual([]);
  });

  it('ranked tries are stops closest-first, wearing the form the player TYPED', () => {
    const model = build(['arbres', 'branche'], 3);
    expect(model.stops.map((s) => [s.rank, s.word])).toEqual([
      [3, 'arbres'], // typed, not the group canonical `arbre`
      [40, 'branche'],
      [87, 'prairie'],
    ]);
  });

  it('a mapless try is a miss, off the line, in try order', () => {
    const model = build(['guitare', 'bois', 'velo'], 1);
    expect(model.misses).toEqual(['guitare', 'velo']);
    expect(model.stops.map((s) => s.rank)).toEqual([1, 87]);
  });

  it('"you are here" is the HOLE\'s rank, even when the log never mentions it', () => {
    // A deduped guess can improve a hole without entering `tried`; the hole is the
    // authority on where the player stands, and the stop falls back to the canonical form.
    const model = build(['branche'], 3);
    const best = model.stops.find((s) => s.best)!;
    expect(best.rank).toBe(3);
    expect(best.word).toBe('arbre');
  });

  it('aliases collapse into ONE stop (#104), and the departure keeps its flag', () => {
    const model = build(['arbre', 'arbres', 'prairie'], 3);
    expect(model.stops.filter((s) => s.rank === 3)).toHaveLength(1);
    const departure = model.stops.find((s) => s.rank === 87)!;
    expect(departure.start).toBe(true);
    expect(departure.word).toBe('prairie');
  });

  it('solving reveals the secret at the terminus; the solving guess is never a stop', () => {
    const model = build(['bois', 'foret'], 0);
    expect(model.solved).toBe(true);
    expect(model.secret).toBe('forêt'); // the accented display form
    expect(model.stops.some((s) => s.rank === 0)).toBe(false); // no rank-0 stop
    expect(model.stops.some((s) => s.best)).toBe(false); // the terminus carries "you"
  });

  it('solving NAMES the whole walked stretch; a live hole names nothing', () => {
    // Live, the line holds only where the player has been. Solved, it becomes the
    // post-mortem: every group from the secret out to the departure is named, and what
    // was actually played stays apart from what was merely there.
    expect(build(['bois'], 1).stops.map((s) => s.rank)).toEqual([1, 87]);
    expect(build(['bois'], 1).stops.some((s) => s.revealed)).toBe(false);

    const solved = build(['bois', 'foret'], 0);
    expect(solved.stops.map((s) => [s.rank, s.revealed])).toEqual([
      [1, false], // played
      [3, true], // named by the solve
      [40, true], // named by the solve
      [87, false], // the departure — handed out, not named
    ]);
    // Named with the group's canonical form: nobody typed these, so there is no typed
    // form to prefer.
    expect(solved.stops.find((s) => s.rank === 3)!.word).toBe('arbre');
  });

  it('the reveal stops AT the departure — nothing behind it is ever named', () => {
    // Behind the start was never on the way, so the post-mortem names nothing there; a
    // backwards guess the player DID play is still their own stop.
    const model = build(['fleur', 'foret'], 0);
    expect(model.stops.filter((s) => s.revealed).map((s) => s.rank)).toEqual([1, 3, 40]);
    expect(model.stops.find((s) => s.rank === 812)!.revealed).toBe(false);
  });

  it('degrades to null dq on pre-#115 data instead of refusing the modal', () => {
    const bare: Record<string, RankEntry> = {
      mot: { word: 'mot', rank: 0 },
      proche: { word: 'proche', rank: 1 },
    };
    const model = buildHistory({
      rankMap: bare,
      tried: ['proche'],
      hole: hole(1),
      startRank: 1,
      secretWord: 'mot',
    });
    expect(model.stops).toEqual([{ rank: 1, dq: null, word: 'proche', start: true, best: true, behind: false, revealed: false }]);
  });

  it('states the map\'s farthest rank so the gutter can be reserved up front', () => {
    expect(build([]).maxRank).toBe(812);
  });

  it('flags a stop farther than the departure as BEHIND; the departure and closer never', () => {
    // `fleur` (812) sits behind the start (87): a real stop, but not a step of the
    // journey, which runs departure → word. Everything at or inside the start is not.
    const model = build(['fleur', 'branche'], 40);
    expect(model.stops.map((s) => [s.rank, s.behind])).toEqual([
      [40, false], // ahead: progress
      [87, false], // the departure is the boundary, never behind itself
      [812, true], // backwards
    ]);
  });
});
