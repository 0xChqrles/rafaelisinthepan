// Podium comments (#236): the model receives IMMUTABLE structured lines and hands back
// prose keyed to them — never a position, a name, a score or an ordering. The answer is
// validated (exactly the expected ids, no duplicate, bounded plain text) and retried
// within a small bounded policy; when the model is unavailable or persistently invalid,
// the podium goes out with no comments. Losing the comedian never loses the scoreboard.

import type { GroupConfig } from '../config/groupConfig';
import type { Podium } from '../domain/podium';
import { lineId, type Comments } from '../domain/podiumText';
import type { Log } from '../log';
import { buildSystemPrompt } from './personality';
import { LlmUnavailable, type LlmProvider } from './types';

export const COMMENT_MAX_CHARS = 140;
const ATTEMPTS = 2;

// Plain text only: no line breaks, no markdown emphasis marks (the renderer italicises the
// line itself), no control characters, collapsed whitespace, quotes the model wrapped it in
// removed. Null when nothing usable is left or it is too long.
export function sanitizeComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^["'«“].*["'»”]$/.test(text)) text = text.slice(1, -1).trim();
  if (text === '' || text.length > COMMENT_MAX_CHARS) return null;
  return text;
}

// The model's whole answer against the ids the podium has. Any deviation is a rejection of
// the WHOLE answer — a half-valid answer is what a retry is for.
export function parseCommentAnswer(
  text: string | null,
  expectedIds: readonly string[],
): Comments | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const lines = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { lines?: unknown }).lines
      : undefined;
  if (!Array.isArray(lines)) return null;
  const expected = new Set(expectedIds);
  const comments = new Map<string, string>();
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return null;
    const { id, comment } = line as { id?: unknown; comment?: unknown };
    const key = typeof id === 'number' ? String(id) : id;
    if (typeof key !== 'string' || !expected.has(key) || comments.has(key)) return null;
    const clean = sanitizeComment(comment);
    if (!clean) return null;
    comments.set(key, clean);
  }
  if (comments.size !== expected.size) return null;
  return comments;
}

export interface PodiumCommentLine {
  id: string;
  position: number;
  score: number;
  names: string[];
}

export function podiumCommentLines(podium: Podium): PodiumCommentLine[] {
  return podium.lines.map((line) => ({
    id: lineId(line),
    position: line.position,
    score: line.score,
    names: line.players.map((p) => p.name),
  }));
}

const TASK = `Task: write ONE short comment per podium line for today's Whippin podium in this group. You receive the lines as JSON (id, position, score, names). Reply with JSON only, of the exact shape {"lines":[{"id":"<id>","comment":"<text>"}]} — one entry per line, every id exactly once, nothing else. Each comment is one plain-text sentence (no line breaks, no markdown, at most ${COMMENT_MAX_CHARS} characters) in the group's language, teasing or celebrating THAT line. Do not restate names, positions or scores — they are printed already. Do not add lines, do not reorder.`;

export async function generatePodiumComments(
  provider: LlmProvider,
  group: GroupConfig,
  podium: Podium,
  log: Log,
): Promise<Comments> {
  const lines = podiumCommentLines(podium);
  if (lines.length === 0) return new Map();
  const ids = lines.map((l) => l.id);
  const system = buildSystemPrompt({
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK,
  });
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await provider.generate({
        system,
        messages: [{ role: 'user', content: JSON.stringify({ lines }) }],
        maxTokens: 80 * lines.length + 60,
        json: true,
        temperature: 1.1,
      });
    } catch (error) {
      const unavailable = error instanceof LlmUnavailable;
      log.warn(
        { event: 'podium.comments_failed', attempt, unavailable, error: (error as Error).message },
        'podium comments unavailable',
      );
      if (!unavailable) return new Map();
      continue;
    }
    log.info(
      {
        event: 'podium.comments_generated',
        attempt,
        latencyMs: response.latencyMs,
        tokens: response.usage,
      },
      'llm answered',
    );
    const comments = parseCommentAnswer(response.text, ids);
    if (comments) return comments;
    log.warn({ event: 'podium.comments_invalid', attempt }, 'rejecting a malformed answer');
  }
  return new Map();
}
