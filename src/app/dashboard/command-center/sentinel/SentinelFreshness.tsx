"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Antigüedad de la lectura mostrada (la tarjeta es una foto del servidor): pasado el umbral lo dice y ofrece releer. No recalcula importes. */
export const STALE_AFTER_MS = 5 * 60_000;
export function freshnessOf(generatedAt: string, now: number): { stale: boolean; minutes: number | null } {
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return { stale: true, minutes: null };
  const ms = Math.max(0, now - t);
  return { stale: ms > STALE_AFTER_MS, minutes: Math.floor(ms / 60_000) };
}

/** Sólo se monta en el navegador (tras el primer efecto), donde el router de la app existe. */
function Reread() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return <button type="button" onClick={() => { setPending(true); router.refresh(); setTimeout(() => setPending(false), 4000); }} disabled={pending} className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-3 font-medium text-white hover:bg-white/10 disabled:opacity-60">{pending ? "Releyendo…" : "Releer ahora"}</button>;
}

export function SentinelFreshness({ generatedAt }: { generatedAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 30_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [generatedAt]);
  if (now === null) return null;
  const f = freshnessOf(generatedAt, now);
  return (
    <div className={`mt-3 flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 text-xs ${f.stale ? "border border-amber-500/40 bg-amber-500/10 text-amber-200" : "text-zinc-400"}`} role="status" data-testid="sentinel-freshness" data-stale={f.stale}>
      <span>{f.minutes === null ? "Lectura sin hora válida: trátala como desactualizada." : f.stale ? `Esta vista se leyó hace ${f.minutes} min y puede no reflejar el estado actual.` : `Lectura de hace ${f.minutes < 1 ? "menos de 1" : f.minutes} min.`}</span>
      <Reread />
    </div>
  );
}
