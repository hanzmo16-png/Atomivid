/** Marca simple: fotograma vertical con acento — sin depender de un asset externo. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="20" height="20" rx="6" className="fill-accent-soft stroke-accent" strokeWidth="1.2" />
        <path d="M9 7l6 4-6 4V7z" className="fill-accent" />
      </svg>
      <span className="text-base font-semibold tracking-tight text-ink">Atomivid</span>
    </span>
  );
}
