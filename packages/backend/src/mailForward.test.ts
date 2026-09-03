import { describe, expect, it } from 'vitest';
import {
  FORWARD_MARKER,
  VERDICT_HEADER,
  forwardDecision,
  forwardFrom,
  forwardedMessage,
  headerFields,
  oversizeNotice,
  readHeader,
  splitMessage,
  verdictLine,
  type SesNotification,
} from './mailForward';

// CONTRACT (#230): what the forwarder may change about a message, and what it must refuse to
// send at all. The rest of the file is AWS wiring; these are the rules.

const MAIL_FROM = 'hello@whippin.ai';

function message(headers: string[], body = 'hello there\r\n'): Buffer {
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'latin1');
}

function receipt(overrides: Partial<SesNotification['receipt']> = {}): SesNotification['receipt'] {
  return {
    spamVerdict: { status: 'PASS' },
    virusVerdict: { status: 'PASS' },
    ...overrides,
  };
}

function fieldsOf(raw: Buffer): string[] {
  return headerFields(splitMessage(raw).header);
}

describe('splitting a raw message', () => {
  it('separates on CRLF CRLF and on bare LF LF', () => {
    const crlf = Buffer.from('Subject: a\r\n\r\nbody', 'latin1');
    expect(splitMessage(crlf).body.toString('latin1')).toBe('body');
    const lf = Buffer.from('Subject: a\n\nbody', 'latin1');
    expect(splitMessage(lf).body.toString('latin1')).toBe('body');
  });

  it('preserves the body byte for byte, 8-bit octets included', () => {
    // A DMARC report's gzip attachment and a screenshot both arrive as raw octets. Decoding
    // them as UTF-8 would replace every invalid sequence with U+FFFD and corrupt the file
    // while still forwarding something that looks like mail.
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xc3, 0x28]);
    const raw = Buffer.concat([Buffer.from('Subject: report\r\n\r\n', 'latin1'), body]);
    expect(splitMessage(raw).body.equals(body)).toBe(true);
    const forwarded = forwardedMessage(raw, { mailFrom: MAIL_FROM });
    expect(splitMessage(forwarded).body.equals(body)).toBe(true);
  });

  it('treats a message with no body as headers only', () => {
    const raw = Buffer.from('Subject: a\r\nFrom: b@c.d', 'latin1');
    expect(splitMessage(raw).body.byteLength).toBe(0);
    expect(readHeader(fieldsOf(raw), 'subject')).toBe('a');
  });
});

describe('header fields', () => {
  it('rejoins a folded field instead of reading its continuation as a field of its own', () => {
    const raw = message(['Subject: one two', ' three four', 'From: a@b.c']);
    const fields = fieldsOf(raw);
    expect(fields).toHaveLength(2);
    expect(readHeader(fields, 'subject')).toBe('one two three four');
  });

  it('matches header names case-insensitively', () => {
    expect(readHeader(fieldsOf(message(['FROM: a@b.c'])), 'from')).toBe('a@b.c');
  });
});

describe('what a forwarded copy changes', () => {
  const original = message([
    'Return-Path: <bounce@example.com>',
    'Received: from mx.example.com',
    'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; b=Zm9vYmFy',
    'Authentication-Results: mx.example.com; spf=pass',
    'From: Ada Lovelace <ada@example.com>',
    'Reply-To: someone-else@example.com',
    'Bcc: hidden@example.com',
    'To: hello@whippin.ai',
    'Subject: my code never arrived',
  ]);

  const forwarded = forwardedMessage(original, {
    mailFrom: MAIL_FROM,
    envelopeSender: 'ada@example.com',
    verdicts: 'spf=PASS dkim=PASS',
  });
  const fields = fieldsOf(forwarded);

  it('sends as the verified sender, wearing the writer’s address', () => {
    // SES only sends as an identity it holds, so From cannot survive. The address still has
    // to be readable in the inbox list, which is what the display name is for.
    expect(readHeader(fields, 'from')).toBe(`"ada@example.com via Whippin" <${MAIL_FROM}>`);
  });

  it('keeps the writer reachable through Reply-To', () => {
    expect(readHeader(fields, 'reply-to')).toBe('Ada Lovelace <ada@example.com>');
  });

  it('drops the signature that signed the old From, rather than shipping a broken one', () => {
    expect(readHeader(fields, 'dkim-signature')).toBeUndefined();
    expect(readHeader(fields, 'return-path')).toBeUndefined();
    expect(readHeader(fields, 'authentication-results')).toBeUndefined();
    expect(readHeader(fields, 'bcc')).toBeUndefined();
  });

  it('keeps everything it has no reason to touch', () => {
    expect(readHeader(fields, 'subject')).toBe('my code never arrived');
    expect(readHeader(fields, 'to')).toBe('hello@whippin.ai');
    expect(readHeader(fields, 'received')).toBe('from mx.example.com');
  });

  it("carries SES's verdicts under a header nothing can mistake for its own", () => {
    expect(readHeader(fields, VERDICT_HEADER)).toBe('spf=PASS dkim=PASS');
  });

  it('falls back to the bare sender when there is no envelope address', () => {
    expect(forwardFrom(undefined, MAIL_FROM)).toBe(`<${MAIL_FROM}>`);
    expect(forwardFrom('', MAIL_FROM)).toBe(`<${MAIL_FROM}>`);
  });

  it('cannot be made to inject a header by a crafted sender or From', () => {
    const hostile = message([
      'From: evil@example.com\r\n\tX-Injected: from-the-original',
      'Subject: hi',
    ]);
    const out = forwardedMessage(hostile, {
      mailFrom: MAIL_FROM,
      envelopeSender: 'evil@example.com>\r\nBcc: victim@example.com',
    });
    const outFields = fieldsOf(out);
    expect(readHeader(outFields, 'bcc')).toBeUndefined();
    // The folded continuation came in as part of the From VALUE, so it is carried into
    // Reply-To as text — one field, never a second header.
    expect(outFields.filter((f) => f.toLowerCase().startsWith('x-injected'))).toHaveLength(0);
    expect(readHeader(outFields, 'from')).not.toContain('\n');
  });
});

describe('what is refused', () => {
  it('forwards an ordinary message', () => {
    const raw = message(['From: a@b.c', 'Subject: hello']);
    expect(forwardDecision({ receipt: receipt(), fields: fieldsOf(raw) })).toEqual({
      forward: true,
    });
  });

  it("refuses what SES already judged spam or a virus", () => {
    const fields = fieldsOf(message(['From: a@b.c']));
    expect(forwardDecision({ receipt: receipt({ spamVerdict: { status: 'FAIL' } }), fields })).toEqual(
      { forward: false, reason: 'spam' },
    );
    expect(
      forwardDecision({ receipt: receipt({ virusVerdict: { status: 'FAIL' } }), fields }),
    ).toEqual({ forward: false, reason: 'virus' });
  });

  it('CLOSES THE LOOP: a message this function sent is never forwarded again', () => {
    // The failure it prevents: the operator's inbox rejects a forward, SES forwards that
    // bounce to hello@, and without the marker it is forwarded straight back at the address
    // that just rejected it — for as long as the mailbox stays broken.
    const raw = message(['From: ada@example.com', 'Subject: hi']);
    const once = forwardedMessage(raw, { mailFrom: MAIL_FROM, envelopeSender: 'ada@example.com' });
    expect(forwardDecision({ receipt: receipt(), fields: fieldsOf(once) })).toEqual({
      forward: false,
      reason: 'loop',
    });
  });

  it('cannot have its marker smuggled past by a duplicate on the way out', () => {
    // An incoming message carrying the marker is refused, so the only way one reaches
    // `forwardedMessage` is a path that skipped the check. It must still leave exactly one.
    const raw = message([`${FORWARD_MARKER}: 1`, 'From: ada@example.com']);
    const out = forwardedMessage(raw, { mailFrom: MAIL_FROM });
    const markers = fieldsOf(out).filter((f) => f.toLowerCase().startsWith(FORWARD_MARKER.toLowerCase()));
    expect(markers).toHaveLength(1);
  });
});

describe('verdict line', () => {
  it('names only the verdicts SES actually gave', () => {
    expect(
      verdictLine({ spamVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'FAIL' } }),
    ).toBe('dmarc=FAIL spam=PASS');
    expect(verdictLine({})).toBe('');
  });
});

describe('a message too large to relay', () => {
  it('says how big it was and where it is', () => {
    const notice = oversizeNotice({
      bytes: 12 * 1024 * 1024,
      key: 'inbound/abc123',
      bucket: 'landing-bucket',
      from: 'ada@example.com',
      subject: 'screenshots',
      recipients: ['hello@whippin.ai'],
      retentionDays: 30,
    });
    expect(notice.subject).toContain('screenshots');
    expect(notice.text).toContain('12.0 MB');
    expect(notice.text).toContain('s3://landing-bucket/inbound/abc123');
    expect(notice.text).toContain('30 days');
  });
});
