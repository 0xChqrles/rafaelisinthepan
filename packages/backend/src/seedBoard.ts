// LOCAL-ONLY leaderboard seeder (#190): fills the RUNNING `pnpm backend:dev` server's
// in-memory stores with a believable population, so the board screen can be seen with
// real rows instead of an empty day. The local stores reset on every server restart,
// which is exactly why this is a script to re-run and not a fixture file.
//
//   pnpm backend:dev                          # keep it running in another terminal
//   pnpm board:seed                           # seed today's fr sentence board
//   pnpm board:seed --friend <publicId|link>  # also link a few seeds to YOUR identity
//
// What it seeds: 60 scored players (40 distinct scores + a 20-player tie across the
// top-50 cut, so shared ranks are visible on both sides of it), most with profiles (a few without,
// to show the pseudonym + dashed-mark fallback), plus a couple of profile-only players
// with NO score (the friends board's "not played yet" rows). It prints INVITE LINKS for
// a few seeds — clicking one in the app is the real one-tap friend flow, and the
// easiest way to land seeds on your own friends board without hunting down your id.
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
  VIEWER_IP_HEADER,
  encodeAvatar,
  invitePath,
  type Puzzle,
} from '@whippin/shared';
import { defaultLocalStoreRoot, sliceKey } from './layout';

const API = process.env.WHIPPIN_API ?? 'http://localhost:8787';
const SITE = process.env.WHIPPIN_SITE ?? 'http://localhost:5199';
const LANG = 'fr';
const MODE = 'sentence';

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
// included). The ACCOUNT behind each one is assigned by the server, so this script learns
// its ids from the bootstrap answer rather than deriving them.
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

async function post(path: string, body: unknown, ip?: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The local adapter forwards headers verbatim, so each seed can present its own
      // viewer address and clear the 5-submissions-per-IP allowance. Local-only: in
      // production this header is overwritten by CloudFront's viewer-request function.
      // The NAME is the shared three-package constant — a rename must reach here too,
      // or the sixth seed silently caps and the board holds 5 rows.
      ...(ip ? { [VIEWER_IP_HEADER]: ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

// The seeds PLAY the published daily, so make sure today's key exists in the local store —
// copying the newest fr sentence puzzle forward is enough for seeding. Its DERIVATION SLICE
// travels with it (#203): the round route reads that on every append, and a day whose slice
// is missing answers the day-addressed 404 with no degraded mode.
function ensureLocalPuzzle(date: string): Puzzle {
  const root = process.env.PUZZLE_STORE ?? defaultLocalStoreRoot();
  const wanted = join(root, `${date}.${LANG}.json`);
  const read = () => JSON.parse(readFileSync(wanted, 'utf8')) as Puzzle;
  if (existsSync(wanted) && existsSync(join(root, sliceKey(date, LANG)))) return read();
  // A fresh clone has no store directory at all — say "publish one first" instead of
  // letting readdirSync surface a raw ENOENT.
  if (!existsSync(root)) {
    throw new Error(`no local puzzle store at ${root} — publish one first.`);
  }
  const candidates = readdirSync(root)
    .filter((name) => name.endsWith(`.${LANG}.json`) && !name.endsWith(`.${LANG}.word.json`))
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

function friendArg(): string | null {
  const flag = process.argv.indexOf('--friend');
  if (flag < 0) return null;
  const raw = process.argv[flag + 1];
  if (!raw) throw new Error('--friend needs a publicId or an invite link.');
  // Either invite spelling, or a bare id: this extracts an id, it does not route.
  const match = /(?:^|\/)([a-z2-7]{16})$/.exec(raw.trim());
  if (!match) throw new Error(`"${raw}" holds no 16-character player id.`);
  return match[1];
}

// Each seed's identity, learned from its own bootstrap. Turnstile is the local accept-all
// verifier, so the challenge is a placeholder here exactly as it is on the round writes.
async function bootstrap(i: number, ip: string): Promise<string> {
  const response = await post('/devices', { token: tokenOf(i), turnstileToken: 'local' }, ip);
  if (!response.ok) {
    throw new Error(`device bootstrap ${i} refused: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { accountId: string }).accountId;
}

async function main() {
  const friendId = friendArg();

  let today: { date: string };
  try {
    today = (await (await fetch(`${API}/today`)).json()) as { date: string };
  } catch {
    throw new Error(`no backend at ${API} — start it first: pnpm backend:dev`);
  }
  const date = today.date;
  const puzzle = ensureLocalPuzzle(date);
  const roundPath = `/round?lang=${LANG}&date=${date}&mode=${MODE}`;

  // 60 scored players: 40 distinct scores, then a 20-player tie across the top-50
  // cut. Every 9th-ish player skips the profile (the assigned-identity fallback).
  // Every seed's account id, so the invite links below can name one without deriving it.
  const accountIds = new Map<number, string>();

  for (let i = 0; i < 60; i += 1) {
    const ip = `10.0.${Math.floor(i / 50)}.${(i % 50) + 1}`;
    const token = tokenOf(i);
    accountIds.set(i, await bootstrap(i, ip));
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
    const r = await post(
      roundPath,
      {
        token,
        // The day's PUBLISHED VERSION (#203) — the round's identity, and what the route
        // checks its slice and rank maps against. An invented tag is a 404 on every seed.
        puzzle: puzzle.revision,
        guesses: playthrough(puzzle, score),
        turnstileToken: 'local',
      },
      ip,
    );
    if (!r.ok) console.log(`[seed] round ${i} refused:`, r.status, await r.text());
  }

  // Two profile-only players with NO score today — the friends board's "not played
  // yet" rows once linked.
  for (const i of [60, 61]) {
    accountIds.set(i, await bootstrap(i, `10.0.2.${i}`));
    const r = await post('/profile', {
      token: tokenOf(i),
      name: NAMES[i % NAMES.length],
      avatar: encodeAvatar(i % 5, drawingOf(i)),
    });
    if (!r.ok) console.log(`[seed] profile ${i} refused:`, r.status, await r.text());
  }

  // Optionally befriend the given identity from a few seeds' side — the mutual write
  // lands both halves, so the caller's board fills without their device token ever leaving
  // their browser.
  if (friendId) {
    for (const i of [2, 7, 19, 47, 60]) {
      const r = await post('/friends', { token: tokenOf(i), add: friendId });
      if (!r.ok) console.log(`[seed] friend link ${i} refused:`, r.status, await r.text());
    }
    console.log(`[seed] linked 5 seeds (one unplayed) to ${friendId}`);
  }

  console.log(`[seed] done — ${LANG} ${MODE} board for ${date} holds 60 scores.`);
  // The REAL shared link (`/i/<publicId>`), preview and all: the dev server proxies
  // `/i/*` to this backend exactly as the CDN does in production (web/vite.config.ts),
  // so a local click walks the same two steps a pasted link does. Set WHIPPIN_SITE if
  // your dev server is not on the port below.
  console.log('[seed] invite links (click one in the app to land that seed on your friends board):');
  for (const i of [11, 33, 61]) {
    const id = accountIds.get(i);
    if (!id) continue;
    const label = i === 61 ? 'has NOT played today' : 'has played';
    console.log(`[seed]   ${SITE}${invitePath(id)}   (${NAMES[i % NAMES.length]}, ${label})`);
  }
}

main().catch((err) => {
  console.error('[seed]', err instanceof Error ? err.message : err);
  process.exit(1);
});
