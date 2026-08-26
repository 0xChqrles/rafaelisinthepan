import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  isValidEmail,
  isValidLinkCode,
  LINK_CODE_LENGTH,
  normalizeEmail,
} from './email';

// CONTRACT (#204). `normalizeEmail` is the CANONICAL spelling of an address, and both
// packages call it: the WEB validates what it types before spending a send, the BACKEND
// validates, normalizes and HASHES what it stores. Two spellings of this pipeline would
// index one address as two accounts — a player linking `Bob@x.com` on their phone and
// `bob@x.com` on their laptop would end up with two, which is the one failure the whole
// flow exists to prevent.

describe('normalizeEmail — one address, one spelling', () => {
  it('folds CASE across the whole address, local part included', () => {
    // Technically case-sensitive per RFC 5321; no provider a player uses treats it that
    // way, and folding is what makes both spellings the same account — which is what a
    // person means when they type either.
    expect(normalizeEmail('Bob@Example.COM')).toBe('bob@example.com');
    expect(normalizeEmail('bob@example.com')).toBe('bob@example.com');
  });

  it('trims surrounding whitespace a paste or an autofill leaves behind', () => {
    expect(normalizeEmail('  zoe@example.com \n')).toBe('zoe@example.com');
  });

  it('normalizes compatibility forms, so one address cannot store as two', () => {
    // A fullwidth `＠` and an NFKC-normalizable label reach the same canonical value.
    expect(normalizeEmail('zoe＠example.com')).toBe('zoe@example.com');
  });

  it('changes NOTHING else — no dot stripping, no +tag folding', () => {
    // Those are Gmail's rules and they are wrong everywhere else: an address this function
    // rewrote would send the code to a mailbox nobody named.
    expect(normalizeEmail('z.o.e+whippin@example.com')).toBe('z.o.e+whippin@example.com');
  });

  it('is IDEMPOTENT, so a value one side normalized survives the other', () => {
    for (const raw of ['  Zoe@Example.COM ', 'a+b@sub.domain.co.uk', 'x@y.io']) {
      const once = normalizeEmail(raw);
      expect(once).not.toBeNull();
      expect(normalizeEmail(once!)).toBe(once);
    }
  });

  it('accepts the addresses a person actually types', () => {
    for (const raw of [
      'a@b.co',
      'first.last@mail.example.org',
      'user+tag@sub.domain.co.uk',
      "o'brien@example.com",
      'zoé@example.com',
    ]) {
      expect(isValidEmail(raw), raw).toBe(true);
    }
  });

  it('refuses what is not an address, and anything over the RFC ceiling', () => {
    for (const raw of [
      '',
      '   ',
      'nobody',
      'no@domain',
      'no@@example.com',
      'spaces in@example.com',
      'trailing@example.',
      'a@b.c',
      42,
      null,
      undefined,
    ]) {
      expect(isValidEmail(raw as unknown), String(raw)).toBe(false);
    }
    expect(isValidEmail(`${'a'.repeat(EMAIL_MAX_LENGTH)}@example.com`)).toBe(false);
  });
});

describe('the six-digit code', () => {
  it('is exactly six DIGITS, leading zeros kept', () => {
    expect(LINK_CODE_LENGTH).toBe(6);
    expect(isValidLinkCode('000000')).toBe(true);
    expect(isValidLinkCode('123456')).toBe(true);
  });

  it('refuses anything a person could not have read off a mail', () => {
    for (const raw of ['12345', '1234567', '12345a', ' 123456', '', 123456, null]) {
      expect(isValidLinkCode(raw as unknown), String(raw)).toBe(false);
    }
  });
});
