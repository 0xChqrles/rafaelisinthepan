import { useCallback, useEffect, useRef, useState } from 'react';
import { dateForDayNumber, encodeWordResult } from '@whippin/shared';
import { track } from '../analytics';
import { t } from '../i18n';

// Word mode's end-of-run screen (#156): the claim count with its unit NAMED (higher is
// better here — "12 WORDS" says what was counted) plus SHARE, in the tray the keyboard
// vacates — the same visual grammar as the sentence game's solved results, minus what a
// word run does not have (no trajectory, no opponents). The share link carries the
// word-mode token, so it unfurls into the word card and clicks through to the day's
// word route.
export default function WordEndScreen({
  score,
  dayNumber,
  lang,
}: {
  score: number;
  dayNumber: number;
  lang: string;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/s/${encodeWordResult({ lang, dayNumber, score })}`;
    const unit = t(lang, score === 1 ? 'word' : 'words').toLowerCase();
    // The day is named by its calendar date, like every share surface (decided
    // 2026-08-03) — the same string the card draws and the link resolves to.
    const headline = `Whippin AI ${dateForDayNumber(dayNumber)} — ${score} ${unit}`;
    const text = `${headline}\n\n${url}`;

    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    if (isTouch && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Whippin AI', text });
        track('share', { method: 'native' });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        // Any other native-share failure falls through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      track('share', { method: 'clipboard' });
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied): there is no further browser fallback.
    }
  }, [lang, dayNumber, score]);

  return (
    <div className="solved-results in">
      <span className="solved-score">
        <span className="solved-score-num">
          <span className="solved-score-live">{score}</span>
        </span>
        <span className="solved-score-unit">{t(lang, score === 1 ? 'word' : 'words')}</span>
      </span>

      <div className="result-actions">
        <button
          type="button"
          className={`result-action${copied ? ' copied' : ''}`}
          onClick={onShare}
        >
          {copied ? t(lang, 'copied') : t(lang, 'share')}
        </button>
      </div>
    </div>
  );
}
