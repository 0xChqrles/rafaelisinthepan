import { t } from '../i18n';
import { formatDuration } from './levels';

// A lesson's length as the article's page prints it (4′50″), and in words for a screen
// reader, which reads the primes as "prime".
export default function Duration({ lang, seconds }: { lang: string; seconds: number }) {
  const spoken = t(lang, 'levelDurationSpoken')
    .replace('{m}', String(Math.floor(seconds / 60)))
    .replace('{s}', String(seconds % 60));
  return (
    <>
      <span aria-hidden="true">{formatDuration(seconds)}</span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}
