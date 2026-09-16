// Per-language lesson script lookup, kept beside the scripts it aggregates.
import type { LessonScript } from '../script';
import en from './en';
import fr from './fr';

export function scriptFor(lang: string): LessonScript {
  return lang === 'fr' ? fr : en;
}
