// THE EVAL FIXTURE (#277): every line the bot wrote in a WhatsApp export, with the
// messages around it, as one JSONL the user rates by hand — `rating: null` becomes
// "good" or "bad", `note` says why. The rated file is what a model or a prompt is measured
// against before it ships (v4 against v4.1, one voice against the next), instead of
// reading the group for a day.
//
//   pnpm bot:fixture <export.md|export.txt> [--bot "<the bot's name in the export>"]
//
// Writes `packages/whatsapp-bot/eval/local/<export basename>.jsonl` — GITIGNORED, like the
// group snapshot, because an export of a private group names real people and this
// repository is public. The bot is found on its own when it can be (the author whose
// messages carry the podium header); name it with `--bot` otherwise.
//
// Two formats: the Markdown export the operator uses ("## September 5, 2026" day headers,
// "[10:31 PM] **Author:** text", a quote as "> _Author: text_"), and WhatsApp's own text
// export ("[09/09/2026, 22:34:12] Author: text" or "9/9/26, 10:34 PM - Author: text").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT_MESSAGES = 6;
const PODIUM_HEADER = /🏆 (Podium Whippin|Whippin podium)/;
const SHARE_LINK = /https?:\/\/\S+\/s\/\S+/g;

function parseMarkdown(text) {
  const lines = text.split('\n');
  const header = /^\[(\d{1,2}:\d{2}(?: [AP]M)?)\] \*\*(.+?):\*\*\s?(.*)$/;
  const dayHeader = /^## (.+)$/;
  const messages = [];
  let day = '';
  for (let i = 0; i < lines.length; i += 1) {
    const d = dayHeader.exec(lines[i]);
    if (d) {
      day = d[1];
      continue;
    }
    const h = header.exec(lines[i]);
    if (!h) continue;
    const body = [h[3]];
    let j = i + 1;
    while (j < lines.length && !header.test(lines[j]) && !dayHeader.test(lines[j]) && lines[j].trim() !== '---' && !lines[j].startsWith('__')) {
      body.push(lines[j]);
      j += 1;
    }
    const raw = body.join('\n').trim();
    const q = /^> _(.+?):\s([\s\S]*?)_\s*\n?([\s\S]*)$/.exec(raw);
    messages.push({
      day,
      time: h[1],
      author: h[2],
      quoted: q ? { author: q[1].trim(), text: q[2].trim() } : null,
      text: (q ? q[3] : raw).trim(),
    });
    i = j - 1;
  }
  return messages;
}

function parseText(text) {
  const bracketed = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}(?::\d{2})?(?: [AP]M)?)\] ([^:]+): ([\s\S]*)$/;
  const dashed = /^(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}(?: [AP]M)?) - ([^:]+): ([\s\S]*)$/;
  const messages = [];
  for (const line of text.split('\n')) {
    const m = bracketed.exec(line) ?? dashed.exec(line);
    if (m) messages.push({ day: m[1], time: m[2], author: m[3].trim(), quoted: null, text: m[4].trim() });
    else if (messages.length > 0) messages[messages.length - 1].text += `\n${line}`;
  }
  return messages;
}

function botAuthor(messages, named) {
  if (named) return named;
  const found = messages.find((m) => PODIUM_HEADER.test(m.text))?.author;
  if (!found) throw new Error('could not tell which author is the bot (no podium found): pass --bot "<name>"');
  return found;
}

function kindOf(message) {
  if (PODIUM_HEADER.test(message.text)) return 'podium';
  if (/whippin\.ai\s*$/i.test(message.text) && !message.quoted) return 'reminder';
  if (message.quoted && /\/s\//.test(message.quoted.text)) return 'share_line';
  return 'reply';
}

const strip = (text) => text.replace(SHARE_LINK, '<share link>').trim();

function main() {
  const args = process.argv.slice(2);
  const named = args.includes('--bot') ? args[args.indexOf('--bot') + 1] : undefined;
  // Resolved from where the command was TYPED (`INIT_CWD`, which pnpm sets), not from the
  // package directory `pnpm --filter` runs in.
  const arg = args.find((a) => !a.startsWith('--') && a !== named);
  const file = arg ? resolve(process.env.INIT_CWD ?? process.cwd(), arg) : undefined;
  if (!file || !existsSync(file)) {
    console.error('usage: pnpm bot:fixture <export.md|export.txt> [--bot "<name>"]');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const messages = file.endsWith('.md') ? parseMarkdown(text) : parseText(text);
  const bot = botAuthor(messages, named);
  const rows = [];
  for (const [i, message] of messages.entries()) {
    if (message.author !== bot) continue;
    rows.push({
      day: message.day,
      time: message.time,
      kind: kindOf(message),
      context: messages
        .slice(Math.max(0, i - CONTEXT_MESSAGES), i)
        .map((m) => ({ who: m.author === bot ? 'bot' : m.author, quoted: m.quoted ? { who: m.quoted.author === bot ? 'bot' : m.quoted.author, text: strip(m.quoted.text) } : null, text: strip(m.text) })),
      quoted: message.quoted ? { who: message.quoted.author === bot ? 'bot' : message.quoted.author, text: strip(message.quoted.text) } : null,
      line: strip(message.text),
      rating: null, // "good" | "bad" — the user's call, nobody else's
      note: '',
    });
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'local', `${basename(file).replace(/\.[^.]+$/, '')}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${rows.length} bot lines from ${messages.length} messages (bot: ${JSON.stringify(bot)}) → ${out}`);
  console.log('Rate each line: set "rating" to "good" or "bad", say why in "note". The file is gitignored.');
}

main();
