import { describe, expect, it, vi } from 'vitest';
import {
  FORWARD_MARKER,
  VERDICT_HEADER,
  forwardConfig,
  forwardDecision,
  forwardFrom,
  forwardNotification,
  forwardedMessage,
  headerFields,
  oversizeNotice,
  readHeader,
  splitMessage,
  type ForwardConfig,
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

  it('STRIPS THE HEADERS SES WOULD OBEY, so a stranger cannot steer our send', () => {
    // SES reads X-SES-* off a raw message as instructions — which configuration set, which
    // tags, which sending-authorization ARNs. Forwarded verbatim, the person who wrote to
    // hello@ is the one choosing them. The verdict header is ours to write, never theirs.
    const hostile = message([
      'From: ada@example.com',
      'X-SES-CONFIGURATION-SET: somebody-elses',
      'X-SES-MESSAGE-TAGS: campaign=spam',
      'X-SES-SOURCE-ARN: arn:aws:ses:us-east-1:000000000000:identity/evil.example',
      'X-SES-FROM-ARN: arn:aws:ses:us-east-1:000000000000:identity/evil.example',
      'X-SES-RETURN-PATH-ARN: arn:aws:ses:us-east-1:000000000000:identity/evil.example',
      'X-SES-LIST-MANAGEMENT-OPTIONS: contactListName=x',
      'X-SES-RECEIPT: AEFBQUFBQUFB',
      `${VERDICT_HEADER}: spf=PASS dkim=PASS dmarc=PASS spam=PASS virus=PASS`,
      'Subject: hi',
    ]);
    const out = fieldsOf(
      forwardedMessage(hostile, { mailFrom: MAIL_FROM, verdicts: 'spam=FAIL' }),
    );
    for (const field of out) {
      expect(field.toLowerCase().startsWith('x-ses-')).toBe(false);
    }
    // Exactly one verdict line, and it is the one SES gave, not the one the sender wrote.
    const verdicts = out.filter((f) => f.toLowerCase().startsWith(VERDICT_HEADER.toLowerCase()));
    expect(verdicts).toHaveLength(1);
    expect(readHeader(out, VERDICT_HEADER)).toBe('spam=FAIL');
    expect(readHeader(out, 'subject')).toBe('hi');
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
    expect(forwardDecision({ receipt: receipt(), raw })).toEqual({ forward: true });
  });

  it("refuses what SES already judged spam or a virus", () => {
    const raw = message(['From: a@b.c']);
    expect(forwardDecision({ receipt: receipt({ spamVerdict: { status: 'FAIL' } }), raw })).toEqual(
      { forward: false, reason: 'spam' },
    );
    expect(
      forwardDecision({ receipt: receipt({ virusVerdict: { status: 'FAIL' } }), raw }),
    ).toEqual({ forward: false, reason: 'virus' });
  });

  it('CLOSES THE LOOP: a message this function sent is never forwarded again', () => {
    // The failure it prevents: the operator's inbox rejects a forward, SES forwards that
    // bounce to hello@, and without the marker it is forwarded straight back at the address
    // that just rejected it — for as long as the mailbox stays broken.
    const raw = message(['From: ada@example.com', 'Subject: hi']);
    const once = forwardedMessage(raw, { mailFrom: MAIL_FROM, envelopeSender: 'ada@example.com' });
    expect(forwardDecision({ receipt: receipt(), raw: once })).toEqual({
      forward: false,
      reason: 'loop',
    });
  });

  it('SEES THE MARKER INSIDE A BOUNCE, where a header lookup never would', () => {
    // This is the loop that actually happens. SES's feedback forwarding sends a DSN whose
    // OWN headers are its own — `From: MAILER-DAEMON@…` — and quotes the failed message in
    // a message/rfc822 part. Reading top-level headers finds no marker there and forwards
    // the bounce, which bounces, forever.
    const ours = forwardedMessage(message(['From: ada@example.com', 'Subject: hi']), {
      mailFrom: MAIL_FROM,
      envelopeSender: 'ada@example.com',
    });
    const bounce = Buffer.concat([
      Buffer.from(
        [
          'From: MAILER-DAEMON@amazonses.com',
          'To: hello@whippin.ai',
          'Subject: Delivery Status Notification (Failure)',
          'Content-Type: multipart/report; report-type=delivery-status; boundary=b',
          '',
          '--b',
          'Content-Type: message/rfc822',
          '',
        ].join('\r\n'),
        'latin1',
      ),
      ours,
      Buffer.from('\r\n--b--\r\n', 'latin1'),
    ]);
    expect(readHeader(fieldsOf(bounce), FORWARD_MARKER)).toBeUndefined();
    expect(forwardDecision({ receipt: receipt(), raw: bounce })).toEqual({
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

// ── The wiring, with the clients faked ───────────────────────────────────────
// The reason `forwardNotification` takes its clients: the ORDER of its refusals and its one
// side effect is the part with a failure mode, and the pure functions above cannot see it.
// A size gate placed before the refusals sends a notice for a message that should have been
// dropped — and answers a looping bounce with a fresh, unmarked message.

const CONFIG: ForwardConfig = {
  bucket: 'landing',
  prefix: 'inbound/',
  mailFrom: MAIL_FROM,
  forwardTo: 'ops@example.com',
  maxBytes: 1024,
  retentionDays: 30,
};

function clientsOver(raw: Buffer) {
  const sent: Record<string, unknown>[] = [];
  const s3 = {
    send: vi.fn(async (_command: { input: Record<string, unknown> }) => ({
      Body: { transformToByteArray: async () => new Uint8Array(raw) },
    })),
  };
  const ses = { send: vi.fn(async (command: { input: Record<string, unknown> }) => {
    sent.push(command.input);
    return {};
  }) };
  return { clients: { s3, ses } as never, sent, s3, ses };
}

function notification(overrides: Partial<SesNotification['receipt']> = {}): SesNotification {
  return {
    mail: { messageId: 'abc123', source: 'ada@example.com', commonHeaders: { subject: 'hi' } },
    receipt: { recipients: ['hello@whippin.ai'], ...receipt(overrides) },
  };
}

function big(headers: string[]): Buffer {
  return message(headers, 'x'.repeat(CONFIG.maxBytes * 2));
}

describe('forwarding a received message', () => {
  it('forwards an ordinary one as raw MIME, marked', async () => {
    const { clients, sent } = clientsOver(message(['From: ada@example.com', 'Subject: hi']));
    await forwardNotification(notification(), CONFIG, clients);
    expect(sent).toHaveLength(1);
    const raw = (sent[0].Content as { Raw: { Data: Buffer } }).Raw.Data;
    expect(readHeader(fieldsOf(Buffer.from(raw)), FORWARD_MARKER)).toBe('1');
    expect(sent[0].Destination).toEqual({ ToAddresses: ['ops@example.com'] });
  });

  it('sends a notice instead when it is too large to relay', async () => {
    const { clients, sent } = clientsOver(big(['From: ada@example.com', 'Subject: hi']));
    await forwardNotification(notification(), CONFIG, clients);
    expect(sent).toHaveLength(1);
    expect(sent[0].Content).toHaveProperty('Simple');
    expect(JSON.stringify(sent[0].Content)).toContain('s3://landing/inbound/abc123');
  });

  it('SENDS NOTHING for a large spam message — the refusal outranks the size', async () => {
    // Gated the other way round, SES's own spam verdict is answered with a mail from our
    // verified domain into a personal inbox, which is how a domain earns a reputation.
    const { clients, sent } = clientsOver(big(['From: spam@example.com']));
    await forwardNotification(notification({ spamVerdict: { status: 'FAIL' } }), CONFIG, clients);
    expect(sent).toEqual([]);
  });

  it('SENDS NOTHING for a large virus message', async () => {
    const { clients, sent } = clientsOver(big(['From: bad@example.com']));
    await forwardNotification(notification({ virusVerdict: { status: 'FAIL' } }), CONFIG, clients);
    expect(sent).toEqual([]);
  });

  it('SENDS NOTHING for a looping message, at any size', async () => {
    // The oversize notice carries no marker, so answering a loop with one reopens the very
    // loop the marker exists to close.
    for (const raw of [
      message([`${FORWARD_MARKER}: 1`, 'From: ada@example.com']),
      big([`${FORWARD_MARKER}: 1`, 'From: ada@example.com']),
    ]) {
      const { clients, sent } = clientsOver(raw);
      await forwardNotification(notification(), CONFIG, clients);
      expect(sent).toEqual([]);
    }
  });

  it('reads the message from the prefixed key it was told about', async () => {
    const { clients, s3 } = clientsOver(message(['From: a@b.c']));
    await forwardNotification(notification(), CONFIG, clients);
    expect(s3.send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: 'landing',
      Key: 'inbound/abc123',
    });
  });
});

describe('reading the bounds from the environment', () => {
  it('falls back rather than letting a non-number remove the cap', () => {
    // `Number('9mb')` is NaN, and NaN loses every comparison — so a typo would not fail,
    // it would silently disable the size gate and hand SES a 40 MB message.
    const env = { ...process.env };
    Object.assign(process.env, {
      MAIL_BUCKET: 'b',
      MAIL_FROM: MAIL_FROM,
      MAIL_FORWARD_TO: 'ops@example.com',
      MAX_FORWARD_BYTES: '9mb',
      MAIL_RETENTION_DAYS: '',
    });
    try {
      const config = forwardConfig();
      expect(config.maxBytes).toBe(9 * 1024 * 1024);
      expect(config.retentionDays).toBe(30);
    } finally {
      process.env = env;
    }
  });
});
