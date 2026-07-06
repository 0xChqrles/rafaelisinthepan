// Per-language onboarding script lookup. Lives HERE (not in ../script.ts) because the
// script files import padRanks from ../script — aggregating them there again would be
// a circular import.
import type { TutorialScript } from '../script';
import en from './en';
import fr from './fr';

export function scriptFor(lang: string): TutorialScript {
  return lang === 'fr' ? fr : en;
}
