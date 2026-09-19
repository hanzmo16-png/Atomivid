/**
 * Marca de Atomivid: núcleo + tres órbitas elípticas (átomo) — conecta con
 * el nombre (Átomo + Video) sin depender de un asset externo. `iconOnly`
 * se usa donde no cabe el wordmark (favicon, avatares compactos).
 */
export function Logo({
  className = "",
  iconOnly = false,
}: {
  className?: string;
  iconOnly?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark />
      {!iconOnly && <span className="text-base font-semibold tracking-tight text-ink">Atomivid</span>}
    </span>
  );
}

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <g stroke="currentColor" className="text-accent" strokeWidth="1.3" strokeLinecap="round">
        <ellipse cx="12" cy="12" rx="10" ry="4.1" />
        <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
      </g>
      <circle cx="12" cy="12" r="2.6" className="fill-accent" />
    </svg>
  );
}
