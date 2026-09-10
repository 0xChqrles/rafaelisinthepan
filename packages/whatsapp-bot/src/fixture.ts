// THE EVAL FIXTURE (#277): every line the bot wrote in a WhatsApp export, with the
// messages around it, as one JSONL the user rates by hand — `rating: null` becomes
// "good" or "bad", `note` says why. The rated file is what a model or a prompt is measured
// against before it ships (one model against the next, one voice against the next),
// instead of shipping it and reading the group for a day.
//
//   pnpm bot:fixture <export.md> [--bot "<the bot's name in the export>"]
//
// Writes `packages/whatsapp-bot/eval/local/<export basename>.jsonl` — GITIGNORED, like the
// group snapshot, because an export of a private group names real people and this
// repository is public. The bot is found on its own when it can be (the author whose
// messages carry the podium header); name it with `--bot` otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExport, type ExportMessage } from './whatsappExport';

const CONTEXT_MESSAGES = 6;
const PODIUM_HEADER = /🏆 (Podium Whippin|Whippin podium)/;
const SHARE_LINK = /https?:\/\/\S+\/s\/\S+/g;

function botAuthor(messages: readonly ExportMessage[], named: string | undefined): string {
  if (named) return named;
  const found = messages.find((m) => PODIUM_HEADER.test(m.text))?.author;
  if (!found) throw new Error('could not tell which author is the bot (no podium found): pass --bot "<name>"');
  return found;
}

function kindOf(message: ExportMessage): string {
  if (PODIUM_HEADER.test(message.text)) return 'podium';
  if (/whippin\.ai\s*$/i.test(message.text) && !message.quoted) return 'reminder';
  if (message.quoted && /\/s\//.test(message.quoted.text)) return 'share_line';
  return 'reply';
}

const strip = (text: string) => text.replace(SHARE_LINK, '<share link>').trim();

function main(): void {
  const args = process.argv.slice(2);
  const named = args.includes('--bot') ? args[args.indexOf('--bot') + 1] : undefined;
  // Resolved from where the command was TYPED (`INIT_CWD`, which pnpm sets), not from the
  // package directory `pnpm --filter` runs in.
  const arg = args.find((a) => !a.startsWith('--') && a !== named);
  if (!arg) {
    console.error('usage: pnpm bot:fixture <export.md> [--bot "<name>"]');
    process.exit(2);
  }
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  const messages = parseExport(readFileSync(file, 'utf8'));
  const bot = botAuthor(messages, named);
  const who = (author: string) => (author === bot ? 'bot' : author);
  const rows = messages.flatMap((message, i) =>
    message.author !== bot
      ? []
      : [
          {
            day: message.day,
            time: message.time,
            kind: kindOf(message),
            context: messages.slice(Math.max(0, i - CONTEXT_MESSAGES), i).map((m) => ({
              who: who(m.author),
              quoted: m.quoted ? { who: who(m.quoted.author), text: strip(m.quoted.text) } : null,
              text: strip(m.text),
            })),
            quoted: message.quoted ? { who: who(message.quoted.author), text: strip(message.quoted.text) } : null,
            line: strip(message.text),
            rating: null, // "good" | "bad" — the user's call, nobody else's
            note: '',
          },
        ],
  );
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'local', `${basename(file).replace(/\.[^.]+$/, '')}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  console.log(`${rows.length} bot lines from ${messages.length} messages (bot: ${JSON.stringify(bot)}) → ${out}`);
  console.log('Rate each line: set "rating" to "good" or "bad", say why in "note". The file is gitignored.');
}

main();
