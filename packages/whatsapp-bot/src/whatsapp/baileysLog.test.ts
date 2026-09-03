import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { baileysLogger, summarize } from './baileysLog';

const SENDER = '33612345678@s.whatsapp.net';

// What the pinned Baileys release actually passes on its warning and error paths.
describe('the Baileys logger cannot print a payload (#236)', () => {
  it('keeps the message and the FIELD NAMES, never the values', () => {
    expect(summarize({ jid: SENDER, err: new Error('no session') }, 'Failed to encrypt')).toEqual({
      msg: 'Failed to encrypt',
      fields: ['jid', 'err'],
      error: 'Error: no session',
    });
    // `{ node: binaryNodeToString(node) }` — a whole protocol node, kept out by name only.
    const node = summarize({ node: `<message from="${SENDER}">body</message>` }, 'error in handling message');
    expect(node).toEqual({ msg: 'error in handling message', fields: ['node'] });
  });

  it('redacts a JID inside anything that DOES survive', () => {
    const line = summarize({ err: `no session record for ${SENDER}` }, `giving up on ${SENDER}`);
    expect(JSON.stringify(line)).not.toContain('33612345678');
    expect(line.error).toContain('no session record for');
  });

  it('takes a one-argument call as the message', () => {
    expect(summarize('no name present, ignoring presence update request...', undefined)).toEqual({
      msg: 'no name present, ignoring presence update request...',
    });
  });

  it('a string FIRST argument is the message, and a string after it is a dropped payload', () => {
    // `logger.info('offline preview received', JSON.stringify(node))` — socket.js, verbatim:
    // the whole node travels in the position a message is usually read from.
    const node = JSON.stringify({
      tag: 'ib',
      attrs: { from: SENDER },
      content: [{ tag: 'offline_preview', attrs: { count: '3' }, content: 'private body' }],
    });
    const line = summarize('offline preview received', node);
    expect(line).toEqual({ msg: 'offline preview received' });
    expect(JSON.stringify(line)).not.toContain('private body');
    expect(JSON.stringify(line)).not.toContain('33612345678');
  });

  it('reads the error text off a payload that IS the error', () => {
    expect(summarize(new Error(`no session for ${SENDER}`), 'decrypt failed')).toMatchObject({
      msg: 'decrypt failed',
      error: expect.stringMatching(/^Error: no session for /),
    });
  });

  it('writes nothing but that summary, at the level it was given', () => {
    const lines: string[] = [];
    const log = pino(
      { level: 'trace', base: undefined },
      { write: (line: string) => lines.push(line) },
    );
    const baileys = baileysLogger(log, 'warn');
    baileys.debug({ jid: SENDER }, 'below the level');
    baileys.child({ class: 'bot' }).warn({ participant: SENDER, retryCount: 3 }, 'retry');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('33612345678');
    const written = JSON.parse(lines[0]);
    expect(written).toMatchObject({ event: 'baileys', msg: 'retry', fields: ['participant', 'retryCount'], scope: ['class'] });
  });
});
