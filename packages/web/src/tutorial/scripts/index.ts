// Per-language onboarding script lookup, kept beside the scripts it aggregates.
import type { TutorialScript } from '../script';
import en from './en';
import fr from './fr';

export function scriptFor(lang: string): TutorialScript {
  return lang === 'fr' ? fr : en;
}
