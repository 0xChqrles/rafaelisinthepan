// Managing group configurations (#236). SSM is the source of truth; this is how a human
// edits it and how a deploy materializes it.
//
//   pnpm bot:groups list            what SSM holds
//   pnpm bot:groups edit <slug>     pull (or start from example.json), $EDITOR, validate, write back
//   pnpm bot:groups rm <slug>       remove from SSM
//   pnpm bot:groups pull [slug]     SSM -> groups/local/, one or all; what deploy runs
//                                     (full pull owns the directory, single pull owns its file)
//
// FOUR COMMANDS, AND THE OMISSIONS ARE THE DESIGN. There is no `disable`, because
// `enabled: false` through `edit` is already exactly that and a second way to say it is a
// second thing to keep in step. There is no `validate`, because validation must not be a
// step somebody can forget: `edit` refuses to write an invalid config and `pull` refuses to
// produce an invalid snapshot, so nothing invalid can reach a deploy through either door.
//
// It opens NO WhatsApp socket and takes NO session lease — it only reads and writes SSM, so
// it is safe to run while the bot is connected. Finding a group's JID in the first place is
// `pnpm bot:cli groups`, which does hold the lease and needs the service scaled to zero.
//
// SSM is regional, and a client in the wrong region reads an EMPTY LIST rather than
// failing — so the region is pinned to the deployment's (`GROUPS_REGION`) instead of being
// inherited from the shell, and printed with every answer. `BOT_AWS_REGION` overrides.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSMClient } from '@aws-sdk/client-ssm';
import { GroupConfigError, assertUniqueGroupIds } from './config/groupConfig';
import {
  GROUPS_PATH,
  GROUPS_REGION,
  assertDeployable,
  assertSlug,
  isSlug,
  removeByHand,
  ssmGroupsStore,
  validateForStore,
  type GroupsStore,
  type StoredGroup,
} from './config/groupsStore';

const here = dirname(fileURLToPath(import.meta.url)); // packages/whatsapp-bot/src
const GROUPS_DIR = join(here, '..', 'groups');
const EXAMPLE = join(GROUPS_DIR, 'example.json');
export const SNAPSHOT_DIR = join(GROUPS_DIR, 'local');

const USAGE = `Usage:
  pnpm bot:groups list
  pnpm bot:groups edit <slug>
  pnpm bot:groups rm <slug>
  pnpm bot:groups pull [slug]
`;

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// What `list` prints, on an operator's own terminal — and ONLY `list`: `pull` runs in CI,
// whose log is public on this repository, so it names the files it wrote and nothing a
// group is (the JID is kept out of every message for the same reason).
const describe = (g: StoredGroup): string =>
  `${g.slug.padEnd(14)} ${g.config.enabled ? 'on ' : 'off'}  ${g.config.language}  ${
    g.config.podium.enabled ? `podium ${g.config.podium.time} ${g.config.podium.timezone}` : 'no podium'
  }  ${g.config.name}`;

// The snapshot a build and a deploy read. Writing it is the ONLY thing that puts a group
// in front of the bot, which is what makes "editing SSM does not change production" true.
// `dir` is a parameter (defaulting to the real snapshot) so tests can pull into a temp
// directory instead of the checkout — `run` threads its own through.
export function writeSnapshot(
  groups: readonly StoredGroup[],
  replaceAll: boolean,
  dir: string = SNAPSHOT_DIR,
): string[] {
  mkdirSync(dir, { recursive: true });
  if (replaceAll) {
    // A stale file is a group the snapshot would silently keep alive after it was removed
    // from SSM, so a full pull OWNS the directory rather than merging into it.
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      rmSync(join(dir, file));
    }
  }
  for (const group of groups) writeFileSync(join(dir, `${group.slug}.json`), group.json);
  return groups.map((g) => `${g.slug}.json`);
}

// $EDITOR on a temp file, looped until what comes back is valid. An invalid config is
// re-opened with the reason at the top rather than thrown away, and leaving it UNCHANGED
// after an error is how you abort — otherwise a typo in a pre-prompt would cost the whole
// edit and there would be no way out but to close the terminal.
//
// `problem` is a reason known BEFORE the editor opens — a stored body the parser already
// refuses — and it opens with that reason on top, exactly as a failed draft reopens.
function editUntilValid(
  slug: string,
  initial: string,
  others: readonly StoredGroup[],
  problem?: string,
): string | null {
  const dir = mkdtempSync(join(tmpdir(), `whippin-group-${slug}-`));
  const file = join(dir, `${slug}.json`);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  // The reason travels INTO the editor: a message printed to a terminal the editor is
  // about to repaint is a message nobody reads. Built from the stripped body so a second
  // failure replaces the header rather than stacking another copy.
  const withReason = (message: string, body: string): string =>
    `// ✗ ${message.split('\n')[0]}\n// Delete this line; save unchanged to abort.\n${body}`;
  let text = problem === undefined ? initial : withReason(problem, initial);
  // The draft outlives ONLY a deliberate abort, where its path is printed as the way back
  // in. Every other exit — a valid save, an editor that failed, an error of ours — removes
  // it: it holds a group's JID, which does not get left sitting in $TMPDIR.
  let keepDraft = false;
  try {
    for (;;) {
      writeFileSync(file, text);
      const before = text;
      const run = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
      if (run.error) throw new GroupConfigError(`could not run ${editor}: ${run.error.message}`);
      if (run.status !== 0) {
        // Killed by a signal (Ctrl-C, a kill), `status` is null and `signal` says what happened.
        const how = run.signal ? `was killed by ${run.signal}` : `exited ${run.status}`;
        throw new GroupConfigError(`${editor} ${how}; nothing written.`);
      }
      text = readFileSync(file, 'utf8');
      // The injected header is not JSON: strip it before validating, so the operator can
      // fix the body while leaving the header in place. The raw text still decides the
      // abort below — only a byte-identical save aborts.
      const stripped = text.replace(/^\/\/ (✗|Delete this line).*\n/gm, '');
      try {
        return validateForStore(slug, stripped, others);
      } catch (error) {
        if (!(error instanceof GroupConfigError)) throw error;
        // THE REASON FIRST, ALWAYS. On the first round there is no earlier error to refer
        // back to, so "unchanged" on its own met a newcomer who opened the template, saved
        // it, and was told nothing about what was wrong with it — which is the one round
        // where the answer ("that is still the placeholder JID") is the whole help.
        say(`\n  ✗ ${error.message}`);
        if (text === before) {
          keepDraft = true;
          say(`    Unchanged — nothing written. Your draft: ${file}`);
          return null;
        }
        say('    Fix it in the editor, or save it unchanged to abort.');
        text = withReason(error.message, stripped);
      }
    }
  } finally {
    if (!keepDraft) rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(argv: readonly string[], store: GroupsStore, snapshotDir: string = SNAPSHOT_DIR): Promise<number> {
  const [command, argument] = argv;

  if (command === 'list') {
    const { groups, broken } = await store.list();
    // The path AND the region, always: "nothing configured" and "looking in the wrong
    // place" are the same answer from SSM, so the answer has to say where it looked.
    say(`${GROUPS_PATH} (${GROUPS_REGION})`);
    if (groups.length === 0 && broken.length === 0) {
      say('  no group configured — add one with: pnpm bot:groups edit <slug>');
      return 0;
    }
    for (const group of groups) say(`  ${describe(group)}`);
    // A broken parameter is listed WITH its way out, and it never stops the listing: this
    // is the screen an operator reads to find out what to fix, so it has to be readable
    // exactly when something is wrong. A slug's body is fixed through `edit` (which opens
    // it as it is) or dropped through `rm`; a name that is no slug is removed by hand.
    for (const b of broken) {
      say(`  ✗ ${b.name}: ${b.reason}`);
      say(
        isSlug(b.name)
          ? `    fix it: pnpm bot:groups edit ${b.name}   or drop it: pnpm bot:groups rm ${b.name}`
          : `    rm cannot name it; drop it by hand: ${removeByHand(b.name)}`,
      );
    }
    // Two usable configs for ONE group are each fine alone and wrong together, and `pull`
    // will refuse them: said here, where the operator is looking.
    try {
      assertUniqueGroupIds(groups.map((g) => ({ id: g.config.id, source: g.slug })));
    } catch (error) {
      if (!(error instanceof GroupConfigError)) throw error;
      say(`  ✗ ${error.message}`);
    }
    return 0;
  }

  if (command === 'edit') {
    if (!argument) return say(USAGE), 1;
    assertSlug(argument);
    const { groups, broken } = await store.list();
    const current = groups.find((g) => g.slug === argument);
    // A body the parser refuses is still THIS slug's, and editing it is how it gets fixed:
    // it opens as it is, with the reason on top, exactly like a draft that failed.
    const damaged = broken.find((b) => b.name === argument);
    if (!current && !damaged && !existsSync(EXAMPLE)) {
      throw new GroupConfigError(`no config for "${argument}" and no template at ${EXAMPLE}`);
    }
    say(
      current
        ? `Editing ${argument}.`
        : damaged
          ? `Editing ${argument}, which SSM holds in a form the bot would refuse.`
          : `New group "${argument}", starting from example.json.`,
    );
    const initial = current?.json ?? damaged?.json ?? readFileSync(EXAMPLE, 'utf8');
    const next = editUntilValid(argument, initial, groups, damaged?.reason);
    if (next === null) return 1;
    if (current && next === current.json) {
      say('No change.');
      return 0;
    }
    await store.put(argument, next);
    say(`Wrote ${argument} to SSM. It reaches the bot on the next deploy.`);
    return 0;
  }

  if (command === 'rm') {
    if (!argument) return say(USAGE), 1;
    assertSlug(argument);
    const removed = await store.remove(argument);
    say(
      removed
        ? `Removed ${argument} from SSM. The bot keeps acting on it until the next deploy.`
        : `No config named ${argument}.`,
    );
    return removed ? 0 : 1;
  }

  if (command === 'pull') {
    if (argument) assertSlug(argument);
    const listing = await store.list();
    // The one command that judges the SET: a snapshot is what a deploy runs on, and
    // nothing invalid reaches one through this door — a single pull included, since the
    // file it writes lands in the same directory the deploy reads whole.
    assertDeployable(listing);
    const all = listing.groups;
    // From here the output names FILES only (see `describe`): this runs in CI.
    if (argument) {
      const found = all.find((g) => g.slug === argument);
      if (!found) {
        // SSM is the source: a slug gone from SSM must not stay alive in the snapshot.
        // A full pull owns the directory (see writeSnapshot); a single pull owns its file.
        const stale = join(snapshotDir, `${argument}.json`);
        if (existsSync(stale)) {
          rmSync(stale);
          say(`Removed ${argument}.json from the snapshot (no longer in SSM).`);
          return 0;
        }
        throw new GroupConfigError(`no config named ${argument}`);
      }
      const [file] = writeSnapshot([found], false, snapshotDir);
      say(`${snapshotDir}`);
      say(`  ${file}`);
      return 0;
    }
    const written = writeSnapshot(all, true, snapshotDir);
    say(`${snapshotDir}  <- ${GROUPS_PATH} (${GROUPS_REGION})`);
    if (written.length === 0) say('  (no group configured in SSM)');
    for (const file of written) say(`  ${file}`);
    return 0;
  }

  say(USAGE);
  return 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('groupsCli.ts');
if (invokedDirectly) {
  run(process.argv.slice(2), ssmGroupsStore(new SSMClient({ region: GROUPS_REGION })))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // A config error is the operator's own input and reads as a sentence; anything else
      // is ours and keeps its stack.
      if (error instanceof GroupConfigError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
