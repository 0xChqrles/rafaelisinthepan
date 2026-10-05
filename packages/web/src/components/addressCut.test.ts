import { describe, expect, it } from 'vitest';
import { cutAddress } from './addressCut';

describe('cutAddress', () => {
  it('leaves an address that fits whole', () => {
    expect(cutAddress('jo@gmail.com', 12)).toBe('jo@gmail.com');
    expect(cutAddress('jo@gmail.com', 40)).toBe('jo@gmail.com');
  });

  it('cuts the local part and keeps the whole domain, in exactly `fit` characters', () => {
    const cut = cutAddress('charles.lanier.dev@gmail.com', 20);
    expect(cut).toBe('charles.l…@gmail.com');
    expect(cut).toHaveLength(20);
  });

  it('cuts once in the middle when the domain leaves no room, its end standing', () => {
    const cut = cutAddress('jo@mail.research-department.university.edu', 21);
    expect(cut).toHaveLength(21);
    expect(cut.startsWith('jo@')).toBe(true);
    expect(cut.endsWith('.edu')).toBe(true);
    expect(cut.split('…')).toHaveLength(2);
  });

  it('never starts on the @ and never loses the domain\'s end', () => {
    for (let fit = 6; fit < 44; fit += 1) {
      const cut = cutAddress('abcdefghij@mail.research-department.university.edu', fit);
      expect(cut.length).toBeLessThanOrEqual(fit);
      expect(cut.startsWith('@')).toBe(false);
      expect(cut.endsWith('u')).toBe(true);
    }
  });
});
