import Flag from '../components/Flag';
import { LANGS, pathForLang, resolveHomeLang } from '../langs';
import { navigate } from '../routing';
import useToday from '../hooks/useToday';
import { progressColor } from '@whippin/shared';
import { useGameStore, roundKeyForDay, type RoundProgress } from '../state/gameStore';
import { t } from '../i18n';

// Per-language status for today, read from the persisted round map (no puzzle load):
//   - none     -> not started (no round yet, or visited without a guess);
//   - solved   -> every hole discovered;
//   - progress -> in progress, with the cached reconstruction %.
type Status = { kind: 'none' } | { kind: 'solved' } | { kind: 'progress'; pct: number };

function statusOf(round: RoundProgress | undefined): Status {
  if (!round || round.guessCount === 0) return { kind: 'none' };
  if (round.holes.length > 0 && round.holes.every((h) => h.rank === 0)) return { kind: 'solved' };
  return { kind: 'progress', pct: Math.round(round.progress) };
}

// Today's status, spoken in the game's own visual language instead of text badges: a
// thin strip along the card's bottom edge. Absent = not started (NOTHING is the "new"
// signal); partial = today's reconstruction %, tinted like the in-game progress bar;
// full GOLD = solved, the same gold as a solved word. Decorative — the aria-label
// carries the status for screen readers.
function StatusStrip({ status }: { status: Status }) {
  if (status.kind === 'none') return null;
  const pct = status.kind === 'solved' ? 100 : status.pct;
  return (
    <span
      className="lang-strip"
      style={{
        width: `${pct}%`,
        background: status.kind === 'solved' ? 'var(--hole)' : progressColor(pct),
      }}
      aria-hidden="true"
    />
  );
}

function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  return '';
}

// The language screen is a ROUTE (/select), not a modal: the header flag links here
// from the game AND the tutorial (whose transient open-state survives the round-trip,
// so picking a language returns into it). One CARD per language — full-opacity flag +
// the language's NATIVE name — in a vertical list that scales to any number of
// languages; hover/press brighten like every key in the app. The per-(day,lang)
// persist keeps each language's in-progress state, so switching needs no confirmation.
export default function LanguageSelect() {
  const dayNumber = useToday();
  const rounds = useGameStore((s) => s.rounds);
  const lastLang = useGameStore((s) => s.lastLang);
  // This screen has no puzzle to take a language from; its chrome follows the same
  // resolution as the `/` redirect (last played, else browser, else English).
  const uiLang = resolveHomeLang(lastLang, navigator.language);

  return (
    <div className="lang-screen">
      <h1 className="title">{t(uiLang, 'selectLanguage')}</h1>
      <div className="lang-list">
        {LANGS.map(({ code, native }) => {
          const status = statusOf(rounds[roundKeyForDay(dayNumber, code)]);
          return (
            <button
              key={code}
              type="button"
              className="lang-card"
              aria-label={`${native}${srStatus(uiLang, status)}`}
              onClick={() => navigate(pathForLang(code))}
            >
              <Flag code={code} className="lang-card-flag" />
              <span className="lang-card-name">{native}</span>
              <StatusStrip status={status} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
