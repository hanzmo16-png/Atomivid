/**
 * Insignia "Avatar" — usada en RequestCard y ResultView para distinguir de
 * un vistazo un video generado con foto/voz propia de uno estándar.
 */
export function ModeBadge() {
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
