"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { IDEA_MAX, SECONDARY_LINKS, continueHref, ideaNote, type CreateFormat, type CreateMode, type FormatOption } from "./home";

const ICON: Record<CreateFormat, string> = {
  reel: "M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm2 5.5l4.5 2.5L8 12.5v-5z",
  podcast: "M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zM5 9a1 1 0 00-2 0 7 7 0 006 6.93V18H7a1 1 0 100 2h6a1 1 0 100-2h-2v-2.07A7 7 0 0017 9a1 1 0 10-2 0 5 5 0 01-10 0z",
  youtube: "M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm6 2.5v5l4.5-2.5L8 7.5z",
};

/** Descripción corta (una línea) para las píldoras; la completa sigue disponible para lectores de pantalla y al pasar el puntero. */
const SHORT: Record<CreateFormat, string> = { reel: "Vertical y corto", podcast: "Voces y música", youtube: "Horizontal y largo" };

/** Vidrio sobre el video de fondo (estilo iOS): translúcido, desenfoque, borde fino claro y brillo superior. */
const GLASS = "border border-white/15 bg-black/35 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur-xl backdrop-saturate-150";
const GLASS_ON = "border border-accent bg-accent/25 shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_0_24px_-6px_rgb(124_106_239/0.7)] backdrop-blur-xl backdrop-saturate-150";

/**
 * Portada «¿Qué quieres crear hoy?»: tres formatos, un campo grande para la idea, Automático/Personalizado y una sola
 * acción («Continuar»), que abre el flujo real del formato. Nada se crea ni se cobra aquí: el presupuesto y la
 * autorización se piden después, en el flujo de cada formato.
 */
export function CreateHome({ formats, subscriptionNeeded = false }: { formats: FormatOption[]; subscriptionNeeded?: boolean }) {
  const router = useRouter();
  const [format, setFormat] = useState<CreateFormat | null>(null);
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState<CreateMode>("auto");
  const [going, setGoing] = useState(false);
  const chosen = formats.find((f) => f.id === format) ?? null;
  const reason = !chosen ? "Elige qué quieres crear." : !chosen.available ? chosen.unavailableReason : null;
  const note = ideaNote(format, idea);
  return (
    <section aria-labelledby="crear-titulo" className="mx-auto w-full min-w-0 max-w-2xl [text-shadow:0_1px_2px_rgb(0_0_0/0.85),0_0_12px_rgb(0_0_0/0.55)]" data-testid="crear-inicio">
      <h2 id="crear-titulo" className="text-2xl font-bold text-ink sm:text-3xl">¿Qué quieres crear hoy?</h2>
      <div role="radiogroup" aria-label="Formato" className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
        {formats.map((f) => {
          const on = format === f.id;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={on} aria-disabled={!f.available} data-testid={`crear-${f.id}`}
              onClick={() => setFormat(f.id)}
              title={f.available ? f.description : f.unavailableReason ?? undefined}
              className={`flex min-h-[76px] w-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl px-2 py-3 text-center transition-[background-color,border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-accent sm:min-h-0 sm:flex-row sm:justify-start sm:gap-3 sm:rounded-full sm:py-2.5 sm:pl-2.5 sm:pr-4 sm:text-left ${on ? GLASS_ON : `${GLASS} hover:border-white/30 hover:bg-black/25`} ${f.available ? "" : "opacity-60"}`}>
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-full sm:size-9 ${on ? "bg-accent text-white" : "bg-white/10 text-accent-hover"}`}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={ICON[f.id]} /></svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight text-white sm:text-base">{f.title}</span>
                <span className="mt-0.5 block truncate text-xs text-white/70" aria-hidden="true">{f.available ? SHORT[f.id] : "Pronto"}</span>
                <span className="sr-only">{f.available ? f.description : f.unavailableReason}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label htmlFor="crear-idea" className="mt-5 block text-sm font-medium text-white">Tu idea</label>
      <textarea id="crear-idea" value={idea} onChange={(e) => setIdea(e.target.value)} maxLength={IDEA_MAX} rows={3}
        placeholder="Describe tu idea…" data-testid="crear-idea"
        className={`mt-1 block w-full min-w-0 rounded-2xl px-4 py-3 text-base text-white placeholder:text-white/65 [text-shadow:none] focus:border-accent ${GLASS}`} />
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-white">Cómo quieres hacerlo</legend>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="crear-modo">
          {([["auto", "Automático", "Nosotros elegimos estilo y detalles; puedes cambiarlos después."], ["custom", "Personalizado", "Tú eliges cada detalle en el siguiente paso."]] as const).map(([id, label, help]) => (
            <label key={id} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-4 text-sm ${mode === id ? `${GLASS_ON} text-white` : `${GLASS} text-white/80`}`} title={help}>
              <input type="radio" name="crear-modo" value={id} checked={mode === id} onChange={() => setMode(id)} className="accent-accent" data-testid={`crear-modo-${id}`} />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-white/90">{mode === "auto" ? "Automático: elegimos estilo y detalles por ti; puedes cambiarlos después." : "Personalizado: tú eliges cada detalle en el siguiente paso."}</p>
      </fieldset>
      {note && <p className="mt-3 text-sm text-white/80" data-testid="crear-nota">{note}</p>}
      {subscriptionNeeded && (
        <p className={`mt-3 rounded-2xl px-3 py-2 text-sm text-white ${GLASS}`} data-testid="crear-aviso-suscripcion">
          Para generar necesitas una suscripción activa. Puedes preparar tu idea ahora.{" "}
          <Link href="/dashboard/billing" className="font-medium text-accent underline">Ver planes</Link>
        </p>
      )}
      <p className="mt-3 text-xs text-white/90">Nada se crea ni se cobra hasta que lo autorices.</p>
      <Button type="button" size="lg" className="mt-3 w-full sm:w-auto" disabled={!!reason || going} loading={going} data-testid="crear-continuar"
        onClick={() => { if (!format || reason) return; setGoing(true); router.push(continueHref(format, idea, mode)); }}>
        Continuar
      </Button>
      {reason && <p className="mt-2 text-sm text-white/80" data-testid="crear-motivo">{reason}</p>}
      <nav aria-label="Accesos" className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" data-testid="crear-accesos">
        {SECONDARY_LINKS.map((l) => <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center text-white/80 underline-offset-4 hover:text-accent hover:underline">{l.label}</Link>)}
      </nav>
      <details className={`mt-2 rounded-2xl px-4 py-2 text-sm ${GLASS}`} data-testid="crear-ayuda">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-ink">Ayuda: ¿cómo funciona?</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-white/80">
          <li>Elige qué crear: Reel, Podcast o Video de YouTube.</li>
          <li>Describe tu idea en una o dos frases.</li>
          <li>En el siguiente paso revisas los detalles. Antes de cualquier cobro ves el máximo y lo autorizas tú.</li>
          <li>Cuando termine, lo encuentras en «Mis proyectos» para verlo y descargarlo.</li>
        </ol>
      </details>
    </section>
  );
}
