import Flag from '../components/Flag';

const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
];

export default function LanguageSelect({ onSelect }: { onSelect: (code: string) => void }) {
  return (
    <div className="lang-screen">
      <h1 className="title">SELECT LANGUAGE</h1>
      <div className="flag-grid">
        {LANGS.map(({ code, label }) => (
          <button
            key={code}
            type="button"
            className="flag-btn"
            aria-label={label}
            title={label}
            onClick={() => onSelect(code)}
          >
            <Flag code={code} />
          </button>
        ))}
      </div>
    </div>
  );
}
