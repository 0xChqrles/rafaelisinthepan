// LOCAL-ONLY leaderboard seeder (#190): fills the RUNNING `pnpm backend:dev` server's
// in-memory stores with a believable population, so the board screen can be seen with
// real rows instead of an empty day. The local stores reset on every server restart,
// which is exactly why this is a script to re-run and not a fixture file.
//
//   pnpm backend:dev                          # keep it running in another terminal
//   pnpm board:seed                           # seed today's fr sentence board
//   pnpm board:seed --group <groupId|link>   # also land a few seeds in YOUR group (#271)
//
// What it seeds: 60 scored players (40 distinct scores + a 20-player tie across the
// top-50 cut, so shared ranks are visible on both sides of it), most with profiles (a few without,
// to show the pseudonym + dashed-mark fallback), plus a couple of profile-only players
// with NO score (a group board's "not played yet" rows) and three MID-ROUND players (a
// partial, unsolved log each — the IN PROGRESS rows). It prints the INVITE LINK of a
// group the seeds created — opening it in the app is the real one-tap join flow, and the
// easiest way to see a populated group board without hunting down ids.
//
// If the active day has no local fr sentence puzzle, the newest one in the local store is
// copied to today's key — its #203 derivation SLICE with it, since the round route reads
// that and a day without one answers the day-addressed 404.
//
// Since #203 a score is not something a client can claim: the server derives it from the
// guess log it stores. So a seed does not POST a number — it PLAYS the day, in one append
// carrying the puzzle's three secrets plus enough distinct misses to land on the score this
// seeder wants (the sentence score is UNIQUE TRIES). That is why this file now reads the
// day's puzzle: only the artifact says what solves it.

import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AVATAR_CELLS,
  GROUP_ID_SOURCE,
  encodeAvatar,
  groupInvitePath,
  type Puzzle,
} from '@whippin/shared';
import { localStoreRoot, sliceKey, storeKey } from './layout';

const API = process.env.WHIPPIN_API ?? 'http://localhost:8787';
const SITE = process.env.WHIPPIN_SITE ?? 'http://localhost:5199';
const LANG = 'fr';

const NAMES = [
  'Zoe', 'Marius_R', 'Cosette', 'lea_bkr', 'Gavroche', 'Eponine', 'ValJean24',
  'Fantine', 'Javert', 'Enjolras', 'Grantaire', 'Azelma', 'Combeferre', 'Courfeyrac',
  'Feuilly', 'Bahorel', 'Joly', 'Bossuet', 'Musichetta', 'Toussaint', 'Magnon',
  'Brevet', 'Chenildieu', 'Babet', 'Gueulemer', 'Claquesous', 'Montparnasse',
  'Favourite', 'Dahlia', 'Zephine', 'Blachevelle', 'Fameuil', 'Listolier',
  'Tholomyes', 'Simplice', 'Perpetue', 'Innocente', 'Gribier', 'Fauchelevent',
  'Mabeuf', 'Plutarque', 'Theodule', 'Gillenormand', 'Pontmercy', 'Mademoiselle',
  'Nicolette', 'Basque', 'Boulatruelle', 'Brujon', 'Panchaud', 'Anzelma',
  'Homere_Hogu', 'Mardisoir', 'Kruideniers', 'Laveuve', 'Finistere', 'Glorieux',
  'Charmante', 'Demihard', 'Buvette', 'Marguerite', 'Isabelot',
];

// Deterministic 64-hex seed DEVICE TOKENS (#216): the same population on every run, so
// re-seeding after a server restart repairs the exact same board (first-write-wins rows
// included). The ACCOUNT behind each one is assigned by the server; every call here names
// its seed by the token alone.
function tokenOf(i: number): string {
  return i.toString(16).padStart(64, '0');
}

// A small deterministic mirrored drawing per seed, so avatars look authored, not noisy.
function drawingOf(seed: number): number[] {
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  let state = (seed * 2654435761 + 1) >>> 0;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let y = 1; y < 9; y += 1) {
    for (let x = 1; x < 5; x += 1) {
      if (next() < 0.42) {
        cells[y * 10 + x] = 1;
        cells[y * 10 + (9 - x)] = 1;
      }
    }
  }
  return cells;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The seeds PLAY the published daily, so make sure today's key exists in the local store —
// copying the newest fr sentence puzzle forward is enough for seeding. Its DERIVATION SLICE
// travels with it (#203): the round route reads that on every append, and a day whose slice
// is missing answers the day-addressed 404 with no degraded mode.
function ensureLocalPuzzle(date: string): Puzzle {
  const root = localStoreRoot();
  const wanted = join(root, storeKey(date, LANG));
  const read = () => JSON.parse(readFileSync(wanted, 'utf8')) as Puzzle;
  if (existsSync(wanted) && existsSync(join(root, sliceKey(date, LANG)))) return read();
  // A fresh clone has no store directory at all — say "publish one first" instead of
  // letting readdirSync surface a raw ENOENT.
  if (!existsSync(root)) {
    throw new Error(`no local puzzle store at ${root} — publish one first.`);
  }
  const candidates = readdirSync(root)
    .filter((name) => name.endsWith(`.${LANG}.json`))
    // Only PAST days: a future-dated test fixture must not become today's sentence.
    .filter((name) => name.slice(0, 10) <= date)
    // …and only ones that carry a slice, since a puzzle without one cannot be played.
    .filter((name) => existsSync(join(root, sliceKey(name.slice(0, 10), LANG))))
    .sort();
  const newest = candidates.at(-1);
  if (!newest) {
    throw new Error(
      `no published ${LANG} sentence puzzle in ${root} to copy to ${date} — run pnpm puzzle:publish first.`,
    );
  }
  const from = newest.slice(0, 10);
  copyFileSync(join(root, newest), wanted);
  copyFileSync(join(root, sliceKey(from, LANG)), join(root, sliceKey(date, LANG)));
  console.log(`[seed] copied ${newest} (+ its slice) -> ${date}.${LANG}.* (local store)`);
  return read();
}

// A log that solves `puzzle` in exactly `score` UNIQUE tries: its secrets, plus distinct
// MISSES to pad. A miss is a counted try like any other (that is what makes a lower score
// better), and it is what lets a seeder aim at a number now that the number is derived.
// The filler is letters only, because a guess on the wire is a folded slug and `fold`
// drops everything else — and it is checked against the day's own maps, so a filler can
// never collapse into another try's identity.
function playthrough(puzzle: Puzzle, score: number): string[] {
  const secrets = [...new Set(puzzle.holes.map((hole) => hole.secret.slug))];
  if (score < secrets.length) {
    throw new Error(`cannot solve ${puzzle.words.length} words in ${score} tries.`);
  }
  const known = (slug: string) =>
    Object.values(puzzle.ranks).some((map) => Object.hasOwn(map, slug));
  const misses: string[] = [];
  for (let i = 0; misses.length < score - secrets.length; i += 1) {
    // Base-26 in letters: `zzaa`, `zzab`, … — never digits, which fold away to nothing.
    const tail = `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
    const filler = `zz${tail}`;
    if (!known(filler)) misses.push(filler);
  }
  // The secrets LAST, so the log reads like a real run ending on its solve.
  return [...misses, ...secrets];
}

// A log that is still UNSOLVED after `tries` unique tries: `near` real neighbours of the
// secrets (never a rank-0 key of any map, so nothing solves), padded with misses. Each seed
// takes its own slice of the neighbours, so the in-progress rows land on different
// percentages — what the board's IN PROGRESS section and the play screen's race line show.
function partialRun(puzzle: Puzzle, tries: number, near: number, offset: number): string[] {
  const solving = (slug: string) => Object.values(puzzle.ranks).some((map) => map[slug]?.rank === 0);
  const neighbours = Object.values(puzzle.ranks)
    .flatMap((map) => Object.entries(map).filter(([, entry]) => entry.rank >= 2 && entry.rank <= 400))
    .sort(([a, x], [b, y]) => x.rank - y.rank || (a < b ? -1 : 1))
    .map(([slug]) => slug)
    .filter((slug, i, all) => all.indexOf(slug) === i && /^[a-z]+$/.test(slug) && !solving(slug));
  const picked = neighbours.filter((_, i) => i % 7 === offset % 7).slice(0, near);
  const misses = playthrough(puzzle, tries - picked.length + puzzle.holes.length).filter(
    (slug) => !solving(slug),
  );
  return [...misses.slice(0, tries - picked.length), ...picked];
}

function groupArg(): string | null {
  const flag = process.argv.indexOf('--group');
  if (flag < 0) return null;
  const raw = process.argv[flag + 1];
  if (!raw) throw new Error('--group needs a group id or an invite link.');
  // Either link spelling, or a bare id: this extracts an id, it does not route.
  const match = new RegExp(`(?:^|/)(${GROUP_ID_SOURCE})$`).exec(raw.trim());
  if (!match) throw new Error(`"${raw}" holds no 16-character group id.`);
  return match[1];
}

// Each seed's identity, created by its own bootstrap. Turnstile is the local accept-all
// verifier, so the challenge is a placeholder here exactly as it is on the round writes.
async function bootstrap(i: number): Promise<void> {
  const response = await post('/devices', { token: tokenOf(i), turnstileToken: 'local' });
  if (!response.ok) {
    throw new Error(`device bootstrap ${i} refused: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const groupId = groupArg();

  let today: { date: string };
  try {
    today = (await (await fetch(`${API}/today`)).json()) as { date: string };
  } catch {
    throw new Error(`no backend at ${API} — start it first: pnpm backend:dev`);
  }
  const date = today.date;
  const puzzle = ensureLocalPuzzle(date);
  const roundPath = `/round?lang=${LANG}&date=${date}`;

  // 60 scored players: 40 distinct scores, then a 20-player tie across the top-50
  // cut. Every 9th-ish player skips the profile (the assigned-identity fallback).
  for (let i = 0; i < 60; i += 1) {
    const token = tokenOf(i);
    await bootstrap(i);
    if (i % 9 !== 4) {
      const r = await post('/profile', {
        token,
        name: NAMES[i % NAMES.length],
        avatar: encodeAvatar(i % 5, drawingOf(i)),
      });
      if (!r.ok) console.log(`[seed] profile ${i} refused:`, r.status, await r.text());
    }
    const score = i < 40 ? i + 3 : 50;
    // ONE append per seed: it creates the round (so it carries the round-start challenge,
    // which the local accept-all verifier waves through), solves the day, and the server
    // derives the score and records the row. The per-daily write interval is per PLAYER,
    // so 60 seeds in a row never pace each other.
    const r = await post(roundPath, {
      token,
      // The day's PUBLISHED VERSION (#203) — the round's identity, and what the route
      // checks its slice and rank maps against. An invented tag is a 404 on every seed.
      puzzle: puzzle.revision,
      guesses: playthrough(puzzle, score),
      turnstileToken: 'local',
    });
    if (!r.ok) console.log(`[seed] round ${i} refused:`, r.status, await r.text());
  }

  // Two profile-only players with NO score today — a group board's "not played
  // yet" rows once linked.
  for (const i of [60, 61]) {
    await bootstrap(i);
    const r = await post('/profile', {
      token: tokenOf(i),
      name: NAMES[i % NAMES.length],
      avatar: encodeAvatar(i % 5, drawingOf(i)),
    });
    if (!r.ok) console.log(`[seed] profile ${i} refused:`, r.status, await r.text());
  }

  // Three players MID-ROUND today: a partial, unsolved log each (no score row), on
  // different percentages and try counts — the board's IN PROGRESS rows and the play
  // screen's race line.
  const PARTIAL = [
    { i: 62, tries: 24, near: 9 },
    { i: 63, tries: 14, near: 4 },
    { i: 64, tries: 31, near: 14 },
  ];
  for (const { i, tries, near } of PARTIAL) {
    await bootstrap(i);
    const p = await post('/profile', {
      token: tokenOf(i),
      name: NAMES[i % NAMES.length],
      avatar: encodeAvatar(i % 5, drawingOf(i)),
    });
    if (!p.ok) console.log(`[seed] profile ${i} refused:`, p.status, await p.text());
    const r = await post(roundPath, {
      token: tokenOf(i),
      puzzle: puzzle.revision,
      guesses: partialRun(puzzle, tries, near, i),
      turnstileToken: 'local',
    });
    if (!r.ok) console.log(`[seed] partial round ${i} refused:`, r.status, await r.text());
  }

  // Optionally land a few seeds in the given group — a JOIN is the caller's own write, so
  // YOUR board fills without your device token ever leaving your browser.
  if (groupId) {
    for (const i of [2, 7, 19, 47, 60, ...PARTIAL.map((seed) => seed.i)]) {
      const r = await post('/groups', { token: tokenOf(i), join: groupId });
      if (!r.ok) console.log(`[seed] group join ${i} refused:`, r.status, await r.text());
    }
    console.log(`[seed] joined 8 seeds (one unplayed, three mid-round) to group ${groupId}`);
  }

  // A seeded GROUP of its own: created by one seed, joined by a handful (one unplayed), so
  // the REAL shared link (`/g/<groupId>`, preview and all — the dev server proxies `/g/*`
  // to this backend exactly as the CDN does, web/vite.config.ts) lands you on a board with
  // rows in it. Set WHIPPIN_SITE if your dev server is not on the port below.
  const created = await post('/groups', { token: tokenOf(11), create: true, name: 'Les_Amis' });
  if (!created.ok) {
    console.log('[seed] group creation refused:', created.status, await created.text());
  } else {
    const seeded = ((await created.json()) as { created: string }).created;
    for (const i of [33, 5, 61, ...PARTIAL.map((seed) => seed.i)]) {
      const r = await post('/groups', { token: tokenOf(i), join: seeded });
      if (!r.ok) console.log(`[seed] group join ${i} refused:`, r.status, await r.text());
    }
    console.log(`[seed] done — ${LANG} board for ${date} holds 60 scores.`);
    console.log('[seed] group invite link (open it in the app to join a board with rows):');
    console.log(
      `[seed]   ${SITE}${groupInvitePath(seeded)}   (Les_Amis: 7 seeds, one has NOT played today, three are mid-round)`,
    );
  }
}

main().catch((err) => {
  console.error('[seed]', err instanceof Error ? err.message : err);
  process.exit(1);
});
