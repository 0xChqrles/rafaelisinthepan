import { describe, expect, it } from 'vitest';
import { withoutShares } from '../domain/share';
import { RecentContext, TURN_MAX_CHARS, WINDOW_MAX_CHARS, boundTurnText } from './context';

const GROUP = '120363000000000001@g.us';
const ORIGIN = 'https://whippin.ai';
const at = (minsAgo: number) => Date.now() - minsAgo * 60_000;

describe('the recent window (#236)', () => {
  it('carries ordinary chatter, so a later question can be answered from it', () => {
    // The case this exists for: the number is said to the GROUP, and asked about later.
    const context = new RecentContext();
    context.push(GROUP, { role: 'user', name: 'Gab', text: 'je pense au nombre 67', at: at(1) });
    context.push(GROUP, { role: 'user', name: 'Zou', text: 'ok', at: at(1) });
    expect(context.recent(GROUP).map((t) => t.text)).toEqual(['je pense au nombre 67', 'ok']);
  });

  it('holds 25 messages and forgets anything older than half an hour', () => {
    const context = new RecentContext();
    for (let i = 0; i < 30; i += 1) {
      context.push(GROUP, { role: 'user', name: 'Gab', text: `m${i}`, at: at(1) });
    }
    const kept = context.recent(GROUP);
    expect(kept).toHaveLength(25);
    expect(kept[0].text).toBe('m5'); // the oldest five fell off the end
    context.push(GROUP, { role: 'user', name: 'Zou', text: 'stale', at: at(31) });
    expect(context.recent(GROUP).map((t) => t.text)).not.toContain('stale');
  });

  it('keeps groups apart', () => {
    const context = new RecentContext();
    context.push(GROUP, { role: 'user', name: 'Gab', text: 'ici', at: at(1) });
    expect(context.recent('120363000000000002@g.us')).toEqual([]);
  });
});

describe('what a share message contributes (#236)', () => {
  // THE WEB'S OWN OUTPUT, verbatim (`web/src/game/share.ts` `shareText` / `wordShareText`,
  // run against the real codec): a headline, the run as emoji, a blank line, the link. The
  // bot cannot import the web, so the shape it strips is pinned here against what the web
  // actually sends.
  const SENTENCE = `Whippin AI 2026-09-03 — 7 essais\n🟥🟨1️⃣2️⃣3️⃣\n\n${ORIGIN}/s/ZBXY-GMSYiy-73w`;
  const CAPPED = `Whippin AI 2026-09-03 — ∞ essais\n🟥🟥🟨\n\n${ORIGIN}/s/ZBXefoGN______-A`;
  const WORD = `Whippin AI 2026-09-03 — 12 mots\n\nPHARE\n⚪7 🟢3 🔵1 🩷1\n\n${ORIGIN}/s/VBXZ8sYDBXBoYXJl`;

  it('drops the WHOLE generated share — headline, row and link — not only the link', () => {
    // The link is what the bot reads a share from, but the block beside it spells the
    // same result out in words and emoji. "A score-only share never reaches the provider"
    // holds only if none of it is remembered: a message that was only a share is EMPTY.
    for (const share of [SENTENCE, CAPPED, WORD]) {
      expect(withoutShares(share, ORIGIN)).toBe('');
    }
  });

  it('keeps what the player typed around the share — the commentary is the conversation', () => {
    expect(withoutShares(`gg\n${SENTENCE}`, ORIGIN)).toBe('gg');
    expect(withoutShares(`${SENTENCE}\ntrop dur aujourd'hui`, ORIGIN)).toBe("trop dur aujourd'hui");
    expect(withoutShares(`bon\n${WORD}\nqui fait mieux ?`, ORIGIN)).toBe('bon qui fait mieux ?');
    // Two shares in one message, words between them.
    expect(withoutShares(`hier\n${SENTENCE}\net aujourd'hui\n${CAPPED}`, ORIGIN)).toBe("hier et aujourd'hui");
  });

  it('strips the token whether the message was addressed to the bot or not', () => {
    // Both paths reach the provider: the ambient one when somebody later addresses the bot,
    // the addressed one immediately AND as the turn the agent records. A share carried by an
    // addressed message ("gg 7 essais <link> @bot qui mène ?") must not be the exception.
    const addressed = `gg 7 essais ${ORIGIN}/s/ZBXg-ISaks2-fA @WhippinBot qui mène ?`;
    const stripped = withoutShares(addressed, ORIGIN);
    expect(stripped).toBe('gg 7 essais @WhippinBot qui mène ?');
    expect(stripped).not.toContain('ZBXg');
    // The block with a question typed after it, on the link's own line or below.
    expect(withoutShares(`${SENTENCE} @WhippinBot qui mène ?`, ORIGIN)).toBe('@WhippinBot qui mène ?');
  });

  it('drops the pieces of a share pasted apart, and nothing a person would say', () => {
    // A bare link, a bare headline, a bare emoji row: each is generated, none is speech.
    expect(withoutShares(`${ORIGIN}/s/ZBXg-ISaks2-fA`, ORIGIN)).toBe('');
    expect(withoutShares('Whippin AI 2026-09-03 — 7 essais', ORIGIN)).toBe('');
    expect(withoutShares('🟥🟨🟪🟦2️⃣', ORIGIN)).toBe('');
    expect(withoutShares('⚪7 🟢3', ORIGIN)).toBe('');
    // A line of capitals is commentary unless it sits INSIDE a headline block — the
    // word-mode WORD line is dropped only there.
    expect(withoutShares('BRAVO', ORIGIN)).toBe('BRAVO');
    expect(withoutShares(`PHARE\n${SENTENCE}`, ORIGIN)).toBe('PHARE');
    // Emoji in a sentence are a sentence.
    expect(withoutShares('trop fort 🟦🟦', ORIGIN)).toBe('trop fort 🟦🟦');
    expect(withoutShares(`a ${ORIGIN}/s/AAA et ${ORIGIN}/s/BBB b`, ORIGIN)).toBe('a et b');
    // Somebody else's link is somebody else's business, and stays as it was.
    expect(withoutShares('https://example.com/s/AAA', ORIGIN)).toBe('https://example.com/s/AAA');
  });
});

describe('the window is bounded in text, not only in messages (#236)', () => {
  it('cuts a pasted wall of text to a turn, keeping its head', () => {
    const context = new RecentContext();
    context.push(GROUP, { role: 'user', name: 'Gab', text: 'x'.repeat(TURN_MAX_CHARS * 3), at: at(1) });
    const [turn] = context.recent(GROUP);
    expect(turn.text).toHaveLength(TURN_MAX_CHARS);
    expect(turn.text.endsWith('…')).toBe(true);
    expect(boundTurnText('court')).toBe('court');
  });

  it('hands out the NEWEST turns that fit the budget, so a few pastes cannot swallow a prompt', () => {
    const context = new RecentContext();
    // Twelve near-maximal turns overshoot the budget; the oldest fall off, the newest stay.
    for (let i = 0; i < 12; i += 1) {
      context.push(GROUP, { role: 'user', name: 'Gab', text: `${i}:${'x'.repeat(TURN_MAX_CHARS - 3)}`, at: at(1) });
    }
    const kept = context.recent(GROUP);
    const size = kept.reduce((n, t) => n + t.text.length, 0);
    expect(size).toBeLessThanOrEqual(WINDOW_MAX_CHARS);
    expect(kept.at(-1)?.text.startsWith('11:')).toBe(true);
    expect(kept[0].text.startsWith(`${12 - kept.length}:`)).toBe(true);
    // A small turn after the pastes is still the newest thing in the window.
    context.push(GROUP, { role: 'user', name: 'Zou', text: 'ok', at: at(0) });
    expect(context.recent(GROUP).at(-1)?.text).toBe('ok');
  });
});
