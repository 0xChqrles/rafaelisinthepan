// Managing group configurations (#236). SSM is the source of truth; this is how a human
// changes it and how a deploy materializes it.
//
//   pnpm bot:groups list            what SSM holds
//   pnpm bot:groups push <slug>     groups/local/<slug>.json -> SSM, validated first
//   pnpm bot:groups rm <slug>       remove from SSM
//   pnpm bot:groups pull [slug]     SSM -> groups/local/, one or all; what deploy runs
//                                     (full pull owns the directory, single pull owns its file)
//
// THE WORKFLOW IS EDIT THE FILE, THEN PUSH IT (user-decided 2026-09-05, replacing `edit`,
// which opened $EDITOR on a temp copy): the snapshot directory is where a config is read
// from anyway, so it is where one is written — `pull`, change `groups/local/<slug>.json` in
// whatever you like, `push`. A new group starts from `groups/example.json` copied to its
// slug. The file the deploy reads and the file the operator edits are the same file, so
// there is no draft to lose and no editor to configure.
//
// FOUR COMMANDS, AND THE OMISSIONS ARE THE DESIGN. There is no `disable`, because
// `enabled: false` pushed is already exactly that and a second way to say it is a second
// thing to keep in step. There is no `validate`, because validation must not be a step
// somebody can forget: `push` refuses to write an invalid config and `pull` refuses to
// produce an invalid snapshot, so nothing invalid can reach a deploy through either door.
//
// It opens NO WhatsApp socket and takes NO session lease — it only reads and writes SSM, so
// it is safe to run while the bot is connected. Finding a group's JID in the first place is
// `pnpm bot:cli groups`, which does hold the lease and needs the service scaled to zero.
//
// SSM is regional, and a client in the wrong region reads an EMPTY LIST rather than
// failing — so the region is pinned to the deployment's (`groupsRegion`) instead of being
// inherited from the shell, and printed with every answer. `BOT_AWS_REGION` overrides.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSMClient } from '@aws-sdk/client-ssm';
import { GroupConfigError, assertUniqueGroupIds } from './config/groupConfig';
import {
  GROUPS_PATH,
  groupsRegion,
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
  pnpm bot:groups push <slug>     groups/local/<slug>.json -> SSM
  pnpm bot:groups rm <slug>
  pnpm bot:groups pull [slug]     SSM -> groups/local/
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

export async function run(argv: readonly string[], store: GroupsStore, snapshotDir: string = SNAPSHOT_DIR): Promise<number> {
  const [command, argument] = argv;

  if (command === 'list') {
    const { groups, broken } = await store.list();
    // The path AND the region, always: "nothing configured" and "looking in the wrong
    // place" are the same answer from SSM, so the answer has to say where it looked.
    say(`${GROUPS_PATH} (${groupsRegion()})`);
    if (groups.length === 0 && broken.length === 0) {
      say(`  no group configured — copy ${EXAMPLE} to groups/local/<slug>.json, fill it in, then: pnpm bot:groups push <slug>`);
      return 0;
    }
    for (const group of groups) say(`  ${describe(group)}`);
    // A broken parameter is listed WITH its way out, and it never stops the listing: this
    // is the screen an operator reads to find out what to fix, so it has to be readable
    // exactly when something is wrong. A slug's body is replaced by pushing a good file
    // over it (`pull` will not hand it back — it refuses a broken set — so the file is
    // written afresh) or dropped through `rm`; a name that is no slug is removed by hand.
    for (const b of broken) {
      say(`  ✗ ${b.name}: ${b.reason}`);
      say(
        isSlug(b.name)
          ? `    fix it: write groups/local/${b.name}.json and: pnpm bot:groups push ${b.name}   or drop it: pnpm bot:groups rm ${b.name}`
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

  if (command === 'push') {
    if (!argument) return say(USAGE), 1;
    assertSlug(argument);
    const file = join(snapshotDir, `${argument}.json`);
    if (!existsSync(file)) {
      throw new GroupConfigError(
        `no ${file}. Pull it first (pnpm bot:groups pull ${argument}), or for a new group copy ${EXAMPLE} there and fill it in.`,
      );
    }
    const { groups } = await store.list();
    // Validated against the OTHER stored groups — a second config for one JID is refused
    // here, before SSM holds two — and canonicalized, so what is stored is what `pull`
    // would hand back and the file is rewritten to match it: the file and SSM say the
    // same thing byte for byte after a push, which is what lets a diff of the file mean
    // something.
    const next = validateForStore(argument, readFileSync(file, 'utf8'), groups);
    const current = groups.find((g) => g.slug === argument);
    if (current && next === current.json) {
      say('No change.');
      return 0;
    }
    await store.put(argument, next);
    writeFileSync(file, next);
    say(`Pushed ${argument} to SSM. It reaches the bot on the next deploy.`);
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
    say(`${snapshotDir}  <- ${GROUPS_PATH} (${groupsRegion()})`);
    if (written.length === 0) say('  (no group configured in SSM)');
    for (const file of written) say(`  ${file}`);
    return 0;
  }

  say(USAGE);
  return 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('groupsCli.ts');
if (invokedDirectly) {
  run(process.argv.slice(2), ssmGroupsStore(new SSMClient({ region: groupsRegion() })))
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
