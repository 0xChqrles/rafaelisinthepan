import { describe, expect, it } from 'vitest';
import { wordRestartNote } from './i18n';

describe('Word gate restart warning (#217)', () => {
  it('calls a lost local run THIS device instead of naming it as somewhere else', () => {
    expect(wordRestartNote('en', 'Mac / Chrome', true)).toBe(
      'A run was already started on this device. Starting over replaces it.',
    );
    expect(wordRestartNote('fr', 'Mac / Chrome', true)).toBe(
      'Une partie a déjà commencé sur cet appareil. Recommencer la remplace.',
    );
  });

  it('still names a genuinely different device whose run will be replaced', () => {
    expect(wordRestartNote('en', 'Mac / Chrome', false)).toBe(
      'Started on Mac / Chrome. Starting here ends that run.',
    );
  });
});
