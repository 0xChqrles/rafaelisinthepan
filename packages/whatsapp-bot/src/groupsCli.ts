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
// inherited from the shell, and printed with every answer. `BOT_GROUPS_REGION` overrides.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSMClient } from '@aws-sdk/client-ssm';
import { GroupConfigError } from './config/groupConfig';
import {
  GROUPS_PATH,
  GROUPS_REGION,
  assertSlug,
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
function editUntilValid(slug: string, initial: string, others: readonly StoredGroup[]): string | null {
  const dir = mkdtempSync(join(tmpdir(), `whippin-group-${slug}-`));
  const file = join(dir, `${slug}.json`);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  let text = initial;
  for (;;) {
    writeFileSync(file, text);
    const before = text;
    const run = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    if (run.error) throw new GroupConfigError(`could not run ${editor}: ${run.error.message}`);
    if (run.status !== 0) throw new GroupConfigError(`${editor} exited ${run.status}; nothing written.`);
    text = readFileSync(file, 'utf8');
    // The injected header is not JSON: strip it before validating, so the operator can fix
    // the body while leaving the header in place. The raw text still decides the abort
    // below — only a byte-identical save aborts.
    const stripped = text.replace(/^\/\/ (✗|Delete this line).*\n/gm, '');
    try {
      const canonical = validateForStore(slug, stripped, others);
      rmSync(dir, { recursive: true, force: true });
      return canonical;
    } catch (error) {
      if (!(error instanceof GroupConfigError)) throw error;
      // THE REASON FIRST, ALWAYS. On the first round there is no earlier error to refer
      // back to, so "unchanged" on its own met a newcomer who opened the template, saved
      // it, and was told nothing about what was wrong with it — which is the one round
      // where the answer ("that is still the placeholder JID") is the whole help.
      say(`\n  ✗ ${error.message}`);
      if (text === before) {
        say(`    Unchanged — nothing written. Your draft: ${file}`);
        return null;
      }
      say('    Fix it in the editor, or save it unchanged to abort.');
      // The reason travels back INTO the editor: a message printed to a terminal the editor
      // is about to repaint is a message nobody reads. Built from the stripped body so a
      // second failure replaces the header rather than stacking another copy.
      const headline = error.message.split('\n')[0];
      text = `// ✗ ${headline}\n// Delete this line; save unchanged to abort.\n${stripped}`;
    }
  }
}

export async function run(argv: readonly string[], store: GroupsStore, snapshotDir: string = SNAPSHOT_DIR): Promise<number> {
  const [command, argument] = argv;

  if (command === 'list') {
    const groups = await store.list();
    // The path AND the region, always: "nothing configured" and "looking in the wrong
    // place" are the same answer from SSM, so the answer has to say where it looked.
    say(`${GROUPS_PATH} (${GROUPS_REGION})`);
    if (groups.length === 0) {
      say('  no group configured — add one with: pnpm bot:groups edit <slug>');
      return 0;
    }
    for (const group of groups) say(`  ${describe(group)}`);
    return 0;
  }

  if (command === 'edit') {
    if (!argument) return say(USAGE), 1;
    assertSlug(argument);
    const all = await store.list();
    const current = all.find((g) => g.slug === argument);
    if (!current && !existsSync(EXAMPLE)) {
      throw new GroupConfigError(`no config for "${argument}" and no template at ${EXAMPLE}`);
    }
    say(current ? `Editing ${argument}.` : `New group "${argument}", starting from example.json.`);
    const initial = current ? current.json : readFileSync(EXAMPLE, 'utf8');
    const next = editUntilValid(argument, initial, all);
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
    const all = await store.list();
    if (argument) {
      const found = all.find((g) => g.slug === argument);
      if (!found) {
        // SSM is the source: a slug gone from SSM must not stay alive in the snapshot.
        // A full pull owns the directory (see writeSnapshot); a single pull owns its file.
        const stale = join(snapshotDir, `${argument}.json`);
        if (existsSync(stale)) {
          rmSync(stale);
          say(`Removed ${argument} from the snapshot (no longer in SSM).`);
          return 0;
        }
        throw new GroupConfigError(`no config named ${argument}`);
      }
      writeSnapshot([found], false, snapshotDir);
      say(`${snapshotDir}`);
      say(`  ${describe(found)}`);
      return 0;
    }
    const written = writeSnapshot(all, true, snapshotDir);
    say(`${snapshotDir}  <- ${GROUPS_PATH} (${GROUPS_REGION})`);
    if (written.length === 0) say('  (no group configured in SSM)');
    for (const group of all) say(`  ${describe(group)}`);
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
