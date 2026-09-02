// Sending the 6-digit code (#204). ONE message shape, two implementations: SES in
// production, the CONSOLE locally — the Turnstile verifier's exact pattern, and for the same
// reason. `backend:dev` has no verified domain and no credentials, so the code has to reach
// the developer some other way, and it must be OBVIOUS which one is running.

import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { LINK_CODE_TTL_SECONDS } from '@whippin/shared';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function sesMailer(client: SESv2Client, from: string): Mailer {
  return {
    async send(message) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              // TEXT ONLY, deliberately: a six-digit code needs no layout, a text part
              // renders identically in every client, and an HTML mail with one number in it
              // is the shape spam filters like least.
              Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
            },
          },
        }),
      );
    },
  };
}

// The local mailer. It PRINTS the code, which is the whole point: `pnpm backend:dev` has no
// verified domain, and a link flow you cannot complete locally is a link flow nobody tests.
// Explicitly local-only — the production entrypoint always wires SES — the same statement
// `localTurnstileVerifier` makes.
export const consoleMailer: Mailer = {
  async send(message) {
    console.log(`\n[mail -> ${message.to}] ${message.subject}\n${message.text}\n`);
  },
};

// What the code mail SAYS, in the player's own language. Two of them, because the game is
// two: an mail arriving in the wrong language reads as a phishing attempt, which is the one
// impression a "confirm it's you" message may not give.
//
// It names the app, the code and how long it stands, and nothing else — no link, no button,
// no branding to spoof. A code mail that asks the reader to click something is teaching them
// the habit this flow was chosen to avoid.
const COPY: Record<string, { subject: (code: string) => string; body: (code: string, minutes: number) => string }> = {
  en: {
    subject: (code) => `${code} is your Whippin code`,
    body: (code, minutes) =>
      [
        `Your Whippin code is ${code}`,
        '',
        `It works for ${minutes} minutes. Type it on the screen that asked for it.`,
        '',
        'If you did not ask for this, nothing has happened to your account — ignore this message.',
      ].join('\n'),
  },
  fr: {
    subject: (code) => `${code} est votre code Whippin`,
    body: (code, minutes) =>
      [
        `Votre code Whippin est ${code}`,
        '',
        `Il est valable ${minutes} minutes. Saisissez-le sur l'écran qui vous l'a demandé.`,
        '',
        "Si vous n'avez rien demandé, votre compte n'a pas bougé — ignorez ce message.",
      ].join('\n'),
  },
};

export function linkCodeMail(to: string, code: string, lang: string): MailMessage {
  const copy = COPY[lang] ?? COPY.en;
  const minutes = Math.round(LINK_CODE_TTL_SECONDS / 60);
  return { to, subject: copy.subject(code), text: copy.body(code, minutes) };
}
