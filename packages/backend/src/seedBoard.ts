// LOCAL-ONLY leaderboard seeder (#190): fills the RUNNING `pnpm backend:dev` server's
// in-memory stores with a believable population, so the board screen can be seen with
// real rows instead of an empty day. The local stores reset on every server restart,
// which is exactly why this is a script to re-run and not a fixture file.
//
//   pnpm backend:dev                          # keep it running in another terminal
//   pnpm board:seed                           # seed today's fr sentence board
//   pnpm board:seed --friend <publicId|/i/…>  # also link a few seeds to YOUR identity
//
// What it seeds: 60 scored players (40 distinct scores + a 20-player tie across the
// top-50 cut, so shared ranks are visible on both sides of it), most with profiles (a few without,
// to show the pseudonym + dashed-mark fallback), plus a couple of profile-only players
// with NO score (the friends board's "not played yet" rows). It prints INVITE LINKS for
// a few seeds — clicking one in the app is the real one-tap friend flow, and the
// easiest way to land seeds on your own friends board without hunting down your id.
//
// If the active day has no local fr sentence puzzle (scores validate against the
// published daily), the newest one in the local store is copied to today's key.

import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_CELLS, VIEWER_IP_HEADER, encodeAvatar, publicIdFromSecret } from '@whippin/shared';
import { defaultLocalStoreRoot } from './layout';

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

// Deterministic 32-hex seed secrets: the same population on every run, so re-seeding
// after a server restart repairs the exact same board (first-write-wins rows included).
function secretOf(i: number): string {
  return i.toString(16).padStart(32, '0');
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

// Scores validate against the PUBLISHED daily, so make sure today's key exists in the
// local store — copying the newest fr sentence puzzle forward is enough for seeding.
function ensureLocalPuzzle(date: string): void {
  const root = process.env.PUZZLE_STORE ?? defaultLocalStoreRoot();
  const wanted = join(root, `${date}.${LANG}.json`);
  if (existsSync(wanted)) return;
  // A fresh clone has no store directory at all — say "publish one first" instead of
  // letting readdirSync surface a raw ENOENT.
  if (!existsSync(root)) {
    throw new Error(`no local puzzle store at ${root} — publish one first.`);
  }
  const candidates = readdirSync(root)
    .filter((name) => name.endsWith(`.${LANG}.json`) && !name.endsWith(`.${LANG}.word.json`))
    // Only PAST days: a future-dated test fixture must not become today's sentence.
    .filter((name) => name.slice(0, 10) <= date)
    .sort();
  const newest = candidates.at(-1);
  if (!newest) {
    throw new Error(`no ${LANG} sentence puzzle in ${root} to copy to ${date} — publish one first.`);
  }
  copyFileSync(join(root, newest), wanted);
  console.log(`[seed] copied ${newest} -> ${date}.${LANG}.json (local store)`);
}

function friendArg(): string | null {
  const flag = process.argv.indexOf('--friend');
  if (flag < 0) return null;
  const raw = process.argv[flag + 1];
  if (!raw) throw new Error('--friend needs a publicId or an /i/<publicId> invite link.');
  const match = /(?:^|\/i\/)([a-z2-7]{16})$/.exec(raw.trim());
  if (!match) throw new Error(`"${raw}" holds no 16-character player id.`);
  return match[1];
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
  ensureLocalPuzzle(date);
  const scoresPath = `/scores?lang=${LANG}&date=${date}&mode=${MODE}`;

  // 60 scored players: 40 distinct scores, then a 20-player tie across the top-50
  // cut. Every 9th-ish player skips the profile (the assigned-identity fallback).
  for (let i = 0; i < 60; i += 1) {
    const secret = secretOf(i);
    if (i % 9 !== 4) {
      const r = await post('/profile', {
        secret,
        name: NAMES[i % NAMES.length],
        avatar: encodeAvatar(i % 5, drawingOf(i)),
      });
      if (!r.ok) console.log(`[seed] profile ${i} refused:`, r.status, await r.text());
    }
    const score = i < 40 ? i + 3 : 50;
    const r = await post(
      scoresPath,
      { secret, score, turnstileToken: 'local' },
      `10.0.${Math.floor(i / 50)}.${(i % 50) + 1}`,
    );
    if (!r.ok) console.log(`[seed] score ${i} refused:`, r.status, await r.text());
  }

  // Two profile-only players with NO score today — the friends board's "not played
  // yet" rows once linked.
  for (const i of [60, 61]) {
    const r = await post('/profile', {
      secret: secretOf(i),
      name: NAMES[i % NAMES.length],
      avatar: encodeAvatar(i % 5, drawingOf(i)),
    });
    if (!r.ok) console.log(`[seed] profile ${i} refused:`, r.status, await r.text());
  }

  // Optionally befriend the given identity from a few seeds' side — the mutual write
  // lands both halves, so the caller's board fills without their secret ever leaving
  // their browser.
  if (friendId) {
    for (const i of [2, 7, 19, 47, 60]) {
      const r = await post('/friends', { secret: secretOf(i), add: friendId });
      if (!r.ok) console.log(`[seed] friend link ${i} refused:`, r.status, await r.text());
    }
    console.log(`[seed] linked 5 seeds (one unplayed) to ${friendId}`);
  }

  console.log(`[seed] done — ${LANG} ${MODE} board for ${date} holds 60 scores.`);
  console.log('[seed] invite links (click one in the app to land that seed on your friends board):');
  for (const i of [11, 33, 61]) {
    const id = await publicIdFromSecret(secretOf(i));
    const label = i === 61 ? 'has NOT played today' : 'has played';
    console.log(`[seed]   ${SITE}/i/${id}   (${NAMES[i % NAMES.length]}, ${label})`);
  }
}

main().catch((err) => {
  console.error('[seed]', err instanceof Error ? err.message : err);
  process.exit(1);
});
