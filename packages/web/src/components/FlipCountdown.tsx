import { useEffect, useState } from 'react';
import { nextResetAt } from '@whippin/shared';
import { srEarlyClock } from '../i18n';

// The clock that takes the KEYBOARD's place once tomorrow's round is locked for the night
// (#273): how long until the day flips and the round continues where it stopped. It is
// the whole statement — no caption: the sentence is still on screen with its guesses, the
// prompt has gone, and a clock counting down where the keys were says when they return.
//
// A wall-clock DEADLINE read at render, Word mode's clock's own shape: nothing here
// counts, so a throttled background tab is still right on its next read. The deadline is
// the next 22:00-ET flip, the app's one day boundary (`shared/day.ts`); the screen that
// mounts this unmounts it when `useToday` reports the flip, so the clock never has to
// decide the round is open again.

const TICK_MS = 1000;
const pad = (n: number) => String(n).padStart(2, '0');

export default function FlipCountdown({ lang }: { lang: string }) {
  const [deadline] = useState(() => nextResetAt(new Date()).getTime());
  const [, bump] = useState(0);
  useEffect(() => {
    const read = () => bump((n) => n + 1);
    const timer = window.setInterval(read, TICK_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, []);
  const left = Math.max(0, deadline - Date.now());
  const seconds = Math.ceil(left / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (
    <div className="flip-clock">
      <span
        className="flip-timer"
        role="timer"
        aria-live="off"
        aria-label={srEarlyClock(lang, Math.ceil(seconds / 60))}
      >
        <span aria-hidden="true">{`${pad(h)}:${pad(m)}:${pad(s)}`}</span>
      </span>
    </div>
  );
}
