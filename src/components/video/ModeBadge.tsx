/**
 * Insignia de modalidad — usada en RequestCard y ResultView para distinguir
 * de un vistazo un video generado con foto/voz propia (Avatar) de uno
 * documental 16:9 (Long Form) de uno estándar (sin insignia, default).
 */
export function ModeBadge({ mode }: { mode: "avatar" | "long_form" }) {
  if (mode === "long_form") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
        <FilmIcon /> Documental
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
      <AvatarIcon /> Avatar
    </span>
  );
}

function AvatarIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 2a5 5 0 100 10 5 5 0 000-10zM3 18a7 7 0 0114 0 1 1 0 01-1 1H4a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M2 4a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm3 1v2h2V5H5zm4 0v2h2V5H9zm4 0v2h2V5h-2zM5 9v2h2V9H5zm4 0v2h2V9H9zm4 0v2h2V9h-2zM5 13v2h2v-2H5zm4 0v2h2v-2H9zm4 0v2h2v-2h-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}
