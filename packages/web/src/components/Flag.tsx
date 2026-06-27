interface FlagInfo {
  src: string;
  alt: string;
}

const FLAGS: Partial<Record<string, FlagInfo>> = {
  en: { src: 'flag-uk.png', alt: 'English flag' },
  fr: { src: 'flag-fr.png', alt: 'French flag' },
};

export default function Flag({ code }: { code: string }) {
  const flag = FLAGS[code];
  if (!flag) return null;

  return (
    <img
      className="flag-img"
      src={`${import.meta.env.BASE_URL}${flag.src}`}
      alt={flag.alt}
      draggable="false"
    />
  );
}
