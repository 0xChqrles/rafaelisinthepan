import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../i18n';

// A READ THAT FAILED, SAID IN PLACE (the house's one spelling of it): the surface keeps its own
// loading picture, held STILL (the caller's — the stipple at half, nothing breathing), and this
// says what the player lost under it — ONE muted line, a note in plain words and sentence case
// — over RETRY, the quiet word in a tappable thing's brackets (`.quiet-btn`). Never the danger
// ink, never a box: a failed read is quiet, and the picture around it already says "unknown".
// `children`: a second quiet act beside RETRY, where one is the way on (the lesson's escape to
// the game on the first visit). A retry hands the picture back to breathing in place.
export default function QuietFailure({
  lang,
  line,
  onRetry,
  className,
  children,
}: {
  lang: string;
  line: string;
  onRetry: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`quiet-failure${className ? ` ${className}` : ''}`}>
      <p className="quiet-failure-line" aria-hidden="true">
        {line}
      </p>
      <SpokenLater line={line} />
      <div className="quiet-failure-acts">
        <button type="button" className="quiet-btn" onClick={onRetry}>
          {t(lang, 'retry')}
        </button>
        {children}
      </div>
    </div>
  );
}

// THE NOTE'S VOICE: a live region that EXISTS BEFORE IT SPEAKS — mounted empty with the note,
// the line set in it a turn later — since a status region inserted already holding its words
// is often not announced. The note on screen is that line's picture (`aria-hidden`), so a
// reader moving through the page meets the words once, here. Out of the flow (`.sr-only`).
export function SpokenLater({ line }: { line: string }) {
  const [said, setSaid] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSaid(line), 0);
    return () => window.clearTimeout(id);
  }, [line]);
  return (
    <span className="sr-only" role="status">
      {said}
    </span>
  );
}
