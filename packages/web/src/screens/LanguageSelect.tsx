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

function StatusBadge({ status, uiLang }: { status: Status; uiLang: string }) {
  if (status.kind === 'solved') return <span className="lang-status lang-status--solved">✓</span>;
  // The % is tinted by its value on the same gradient the in-game progress bar uses,
  // so a language's badge reads at a glance like its reconstruction progress. Modifier
  // classes are namespaced (lang-status--*) so they can't collide with the .progress bar.
  if (status.kind === 'progress') {
    return (
      <span className="lang-status lang-status--progress" style={{ color: progressColor(status.pct) }}>
        {status.pct}%
      </span>
    );
  }
  return <span className="lang-status lang-status--none">{t(uiLang, 'newBadge')}</span>;
}

// The language selector is a ROUTE (/select), not a modal: the HUD flag links here.
// Picking a language navigates to its puzzle; the existing per-(day,lang) persist keeps
// each language's in-progress state, so switching mid-game needs no confirmation.
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
      <div className="flag-grid">
        {LANGS.map(({ code, label }) => {
          const round = rounds[roundKeyForDay(dayNumber, code)];
          return (
            <button
              key={code}
              type="button"
              className="flag-btn"
              aria-label={label}
              title={label}
              onClick={() => navigate(pathForLang(code))}
            >
              <Flag code={code} />
              <StatusBadge status={statusOf(round)} uiLang={uiLang} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
