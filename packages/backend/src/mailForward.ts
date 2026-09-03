// Forwarding inbound mail to a human (#230). SES receiving drops each message into S3 and
// then invokes this function; it fetches the raw MIME, rewrites the few headers that must
// change, and re-sends it to the operator's real inbox.
//
// It exists because #204 made this game SEND mail and nothing handled what came back:
// `hello@<domain>` is the address the privacy notice tells players to write to, the address
// SES forwards its own bounce and complaint notifications to (no Return-Path is set, so they
// go to the From), and — with `abuse@`, `postmaster@` and `dmarc@` — the mail a domain is
// expected to answer on. Every one of those was landing on a domain with no MX.
//
// **It is NOT the code mailer, and must not become it.** `mailer.ts` is one message shape
// with a text body, deliberately (#230's third note): it addresses PLAYERS, and anything
// beyond a six-digit code needs its own sender, template and unsubscribe story. This file
// addresses the OPERATOR, sends raw MIME rather than a template, and shares nothing with it.
//
// **Why the headers change at all.** The message is re-sent from our own domain, so `From:`
// has to become the verified sender or SES refuses it — and the moment `From` changes, the
// original `DKIM-Signature` no longer verifies and has to go, or the receiving side reads a
// broken signature rather than an absent one. The original sender survives as `Reply-To:`,
// so replying from the inbox reaches the person who wrote.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

// ── The slice of the SES receipt event this reads ────────────────────────────
// Typed locally rather than pulled from @types/aws-lambda: four fields, and a dependency
// added for four fields is a dependency to keep in step forever.

interface SesVerdict {
  status?: string;
}

export interface SesNotification {
  mail: {
    messageId: string;
    source?: string;
    destination?: string[];
    commonHeaders?: { from?: string[]; subject?: string };
  };
  receipt: {
    recipients?: string[];
    spamVerdict?: SesVerdict;
    virusVerdict?: SesVerdict;
    spfVerdict?: SesVerdict;
    dkimVerdict?: SesVerdict;
    dmarcVerdict?: SesVerdict;
  };
}

export interface SesEvent {
  Records?: { ses?: SesNotification }[];
}

// ── The header contract ──────────────────────────────────────────────────────

// Stamped on every message this function sends, and REFUSED on every message it receives.
// That is the whole loop guard: the operator's inbox can bounce (a full mailbox, a
// disappeared address), SES forwards that bounce to `hello@`, and without this the bounce
// would be forwarded straight back at the address that just rejected it, forever.
export const FORWARD_MARKER = 'X-Whippin-Forwarded';

// SES's own judgement of the message, carried across in one line. The raw
// `Authentication-Results` is dropped below because it describes a hop the receiving side is
// not entitled to trust; these are the same facts, plainly ours and plainly about the
// original message.
export const VERDICT_HEADER = 'X-Whippin-Verdicts';

// Dropped when the message is re-sent.
//   from            — replaced; SES only sends as a verified identity.
//   dkim-signature  — signed a `From` that no longer stands. A broken signature reads worse
//   domainkey-signature   than none at all.
//   reply-to        — replaced with the original sender, so a reply reaches them.
//   return-path     — the envelope is SES's to set on the new message.
//   sender          — would name the old originator beside a new From.
//   bcc             — must never survive a relay.
//   authentication-results / received-spf — verdicts about the ORIGINAL delivery. Kept as
//                     VERDICT_HEADER instead, where nothing can mistake them for its own.
const DROPPED_HEADERS = new Set([
  'from',
  'reply-to',
  'return-path',
  'sender',
  'bcc',
  'dkim-signature',
  'domainkey-signature',
  'x-google-dkim-signature',
  'authentication-results',
  'received-spf',
  FORWARD_MARKER.toLowerCase(),
]);

// ── Pure message surgery ─────────────────────────────────────────────────────

/**
 * Split a raw message into its header block and its body BYTES.
 *
 * The header block is decoded as latin1 and the body is never decoded at all, so both
 * round-trip byte for byte: a message may carry raw 8-bit octets in either (invalid per RFC
 * 5322, and common), and a utf8 decode would replace every one of them with U+FFFD —
 * silently corrupting the attachment on a DMARC report or a screenshot a player sent.
 */
export function splitMessage(raw: Buffer): { header: string; body: Buffer } {
  let index = raw.indexOf('\r\n\r\n');
  let separator = 4;
  if (index < 0) {
    index = raw.indexOf('\n\n');
    separator = 2;
  }
  if (index < 0) return { header: raw.toString('latin1'), body: Buffer.alloc(0) };
  return { header: raw.subarray(0, index).toString('latin1'), body: raw.subarray(index + separator) };
}

/**
 * The header block as whole FIELDS, with folded continuation lines rejoined onto the field
 * they continue — so a `Subject` wrapped over three lines is one entry and cannot be
 * mistaken for three unnamed ones.
 */
export function headerFields(header: string): string[] {
  const fields: string[] = [];
  for (const line of header.split(/\r?\n/)) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1] += `\r\n${line}`;
    else fields.push(line);
  }
  return fields;
}

export function fieldName(field: string): string {
  const colon = field.indexOf(':');
  return (colon < 0 ? field : field.slice(0, colon)).trim().toLowerCase();
}

export function fieldValue(field: string): string {
  const colon = field.indexOf(':');
  return colon < 0 ? '' : field.slice(colon + 1).trim();
}

/** The first occurrence of a header, unfolded onto one line. */
export function readHeader(fields: string[], name: string): string | undefined {
  const found = fields.find((field) => fieldName(field) === name.toLowerCase());
  return found === undefined ? undefined : fieldValue(found).replace(/\r?\n[ \t]+/g, ' ');
}

// A header value we WRITE. Anything outside printable ASCII goes, which takes CR and LF with
// it — a newline reaching a header we compose is header injection, and everything composed
// here is built from a stranger's message.
function safeHeaderValue(value: string, limit: number): string {
  return value
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * The `From:` the forwarded copy carries: our verified sender, wearing the original sender's
 * address as its display name, so the inbox says who wrote before it is opened.
 *
 * The label is built from the ENVELOPE sender rather than the original `From` header on
 * purpose — the envelope is a bare addr-spec, where a `From` display name is routinely an
 * encoded-word (`=?UTF-8?B?…?=`), which decodes to mojibake once it is quoted inside another
 * display name. The original `From` survives untouched as `Reply-To`.
 */
export function forwardFrom(envelopeSender: string | undefined, mailFrom: string): string {
  const label = safeHeaderValue((envelopeSender ?? '').replace(/["\\]/g, ''), 64);
  return label ? `"${label} via Whippin" <${mailFrom}>` : `<${mailFrom}>`;
}

/** One line of SES's verdicts, for triaging a bounce without opening the S3 copy. */
export function verdictLine(receipt: SesNotification['receipt']): string {
  const parts = [
    ['spf', receipt.spfVerdict?.status],
    ['dkim', receipt.dkimVerdict?.status],
    ['dmarc', receipt.dmarcVerdict?.status],
    ['spam', receipt.spamVerdict?.status],
    ['virus', receipt.virusVerdict?.status],
  ] as const;
  return parts
    .filter(([, status]) => Boolean(status))
    .map(([label, status]) => `${label}=${status}`)
    .join(' ');
}

export type ForwardRefusal = 'spam' | 'virus' | 'loop';

/**
 * Whether a received message is forwarded at all.
 *
 * Spam and virus are SES's own verdicts (the rule set has scanning on): relaying either into
 * a personal inbox from our own verified domain is how a domain earns the reputation this
 * issue's alarms watch. The loop refusal is the one that matters operationally — see
 * FORWARD_MARKER.
 */
export function forwardDecision(input: {
  receipt: SesNotification['receipt'];
  fields: string[];
}): { forward: true } | { forward: false; reason: ForwardRefusal } {
  if (input.receipt.spamVerdict?.status === 'FAIL') return { forward: false, reason: 'spam' };
  if (input.receipt.virusVerdict?.status === 'FAIL') return { forward: false, reason: 'virus' };
  if (readHeader(input.fields, FORWARD_MARKER) !== undefined) {
    return { forward: false, reason: 'loop' };
  }
  return { forward: true };
}

/**
 * The message to re-send: the original with `From` replaced, the original sender preserved as
 * `Reply-To`, the signatures that no longer hold removed, and this function's own two headers
 * added. The body is passed through untouched.
 */
export function forwardedMessage(
  raw: Buffer,
  options: { mailFrom: string; envelopeSender?: string; verdicts?: string },
): Buffer {
  const { header, body } = splitMessage(raw);
  const fields = headerFields(header);
  const originalFrom = readHeader(fields, 'from');
  const replyTo = safeHeaderValue(originalFrom ?? options.envelopeSender ?? '', 320);

  const added = [
    `From: ${forwardFrom(options.envelopeSender, options.mailFrom)}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `${FORWARD_MARKER}: 1`,
    ...(options.verdicts ? [`${VERDICT_HEADER}: ${safeHeaderValue(options.verdicts, 200)}`] : []),
  ];
  const kept = fields.filter((field) => !DROPPED_HEADERS.has(fieldName(field)));

  return Buffer.concat([
    Buffer.from(`${[...added, ...kept].join('\r\n')}\r\n\r\n`, 'latin1'),
    body,
  ]);
}

/**
 * What is sent INSTEAD of a message too large to relay. SES accepts up to 40 MB inbound,
 * which is more than this function should pull into memory or hand back to SES — and a
 * message that is silently never forwarded is the exact failure #230 is about, so the size
 * itself becomes the notification.
 */
export function oversizeNotice(input: {
  bytes: number;
  key: string;
  bucket: string;
  from?: string;
  subject?: string;
  recipients?: string[];
  retentionDays: number;
}): { subject: string; text: string } {
  const megabytes = (input.bytes / (1024 * 1024)).toFixed(1);
  return {
    subject: `[whippin] Large message not forwarded: ${safeHeaderValue(input.subject ?? '(no subject)', 120)}`,
    text: [
      `A message arrived that was too large to forward (${megabytes} MB).`,
      '',
      `From:    ${input.from ?? '(unknown)'}`,
      `To:      ${(input.recipients ?? []).join(', ') || '(unknown)'}`,
      `Subject: ${input.subject ?? '(no subject)'}`,
      '',
      `It is stored at s3://${input.bucket}/${input.key} and is deleted after ${input.retentionDays} days.`,
    ].join('\n'),
  };
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export interface ForwardConfig {
  bucket: string;
  prefix: string;
  mailFrom: string;
  forwardTo: string;
  maxBytes: number;
  retentionDays: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`mailForward: ${name} is not set`);
  return value;
}

export function forwardConfig(): ForwardConfig {
  return {
    bucket: required('MAIL_BUCKET'),
    prefix: process.env.MAIL_PREFIX ?? '',
    mailFrom: required('MAIL_FROM'),
    forwardTo: required('MAIL_FORWARD_TO'),
    maxBytes: Number(process.env.MAX_FORWARD_BYTES ?? 9 * 1024 * 1024),
    retentionDays: Number(process.env.MAIL_RETENTION_DAYS ?? 30),
  };
}

const s3 = new S3Client({});
const ses = new SESv2Client({});

export async function forwardNotification(
  notification: SesNotification,
  config: ForwardConfig,
  clients: { s3: S3Client; ses: SESv2Client } = { s3, ses },
): Promise<void> {
  const key = `${config.prefix}${notification.mail.messageId}`;
  const object = await clients.s3.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  if (!object.Body) throw new Error(`mailForward: no body at ${key}`);
  const raw = Buffer.from(await object.Body.transformToByteArray());

  if (raw.byteLength > config.maxBytes) {
    const notice = oversizeNotice({
      bytes: raw.byteLength,
      key,
      bucket: config.bucket,
      from: notification.mail.source,
      subject: notification.mail.commonHeaders?.subject,
      recipients: notification.receipt.recipients,
      retentionDays: config.retentionDays,
    });
    await clients.ses.send(
      new SendEmailCommand({
        FromEmailAddress: config.mailFrom,
        Destination: { ToAddresses: [config.forwardTo] },
        Content: {
          Simple: {
            Subject: { Data: notice.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: notice.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return;
  }

  const { header } = splitMessage(raw);
  const decision = forwardDecision({
    receipt: notification.receipt,
    fields: headerFields(header),
  });
  if (!decision.forward) {
    // Logged, never forwarded, and never an error: a refusal is this function working. The
    // message stays in S3 for its retention window if anyone wants to look.
    console.log(
      `[mail] not forwarded (${decision.reason}) messageId=${notification.mail.messageId}`,
    );
    return;
  }

  await clients.ses.send(
    new SendEmailCommand({
      FromEmailAddress: config.mailFrom,
      // Naming the destination overrides the message's own To/Cc — which still says
      // `hello@<domain>`, and is worth keeping visible: it tells the reader which alias the
      // mail actually came in on.
      Destination: { ToAddresses: [config.forwardTo] },
      Content: {
        Raw: {
          Data: forwardedMessage(raw, {
            mailFrom: config.mailFrom,
            envelopeSender: notification.mail.source,
            verdicts: verdictLine(notification.receipt),
          }),
        },
      },
    }),
  );
}

export const handler = async (event: SesEvent): Promise<void> => {
  const config = forwardConfig();
  for (const record of event.Records ?? []) {
    // Sequential: SES delivers one record per invocation in practice, and a failure has to
    // reach Lambda so the retry (and the error alarm behind it) happens.
    if (record.ses) await forwardNotification(record.ses, config);
  }
};
