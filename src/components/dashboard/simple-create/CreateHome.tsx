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

/**
 * Portada «¿Qué quieres crear hoy?»: tres formatos, un campo grande para la idea, Automático/Personalizado y una sola
 * acción («Continuar»), que abre el flujo real del formato. Nada se crea ni se cobra aquí: el presupuesto y la
 * autorización se piden después, en el flujo de cada formato.
 */
export function CreateHome({ formats, greeting }: { formats: FormatOption[]; greeting?: string | null }) {
  const router = useRouter();
  const [format, setFormat] = useState<CreateFormat | null>(null);
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState<CreateMode>("auto");
  const [going, setGoing] = useState(false);
  const chosen = formats.find((f) => f.id === format) ?? null;
  const reason = !chosen ? "Elige qué quieres crear." : !chosen.available ? chosen.unavailableReason : null;
  const note = ideaNote(format, idea);
  return (
    <section aria-labelledby="crear-titulo" className="mx-auto w-full min-w-0 max-w-2xl" data-testid="crear-inicio">
      {greeting && <p className="text-sm text-ink-muted">{greeting}</p>}
      <h1 id="crear-titulo" className="text-2xl font-bold text-ink sm:text-3xl">¿Qué quieres crear hoy?</h1>
      <div role="radiogroup" aria-label="Formato" className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {formats.map((f) => {
          const on = format === f.id;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={on} aria-disabled={!f.available} data-testid={`crear-${f.id}`}
              onClick={() => setFormat(f.id)}
              className={`flex min-h-[88px] w-full min-w-0 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${on ? "border-accent bg-accent-soft/40" : "border-border-strong bg-surface-raised hover:border-accent-border"} ${f.available ? "" : "opacity-60"}`}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={ICON[f.id]} /></svg>
              </span>
              <span className="min-w-0">
                <span className="block text-base font-semibold text-ink">{f.title}</span>
                <span className="block text-sm text-ink-muted">{f.available ? f.description : f.unavailableReason}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label htmlFor="crear-idea" className="mt-5 block text-sm font-medium text-ink">Tu idea</label>
      <textarea id="crear-idea" value={idea} onChange={(e) => setIdea(e.target.value)} maxLength={IDEA_MAX} rows={4}
        placeholder="Describe tu idea…" data-testid="crear-idea"
        className="mt-1 block w-full min-w-0 rounded-xl border border-border-strong bg-surface-raised px-4 py-3 text-base text-ink" />
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink">Cómo quieres hacerlo</legend>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="crear-modo">
          {([["auto", "Automático", "Nosotros elegimos estilo y detalles; puedes cambiarlos después."], ["custom", "Personalizado", "Tú eliges cada detalle en el siguiente paso."]] as const).map(([id, label, help]) => (
            <label key={id} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${mode === id ? "border-accent bg-accent-soft/40 text-ink" : "border-border text-ink-muted"}`} title={help}>
              <input type="radio" name="crear-modo" value={id} checked={mode === id} onChange={() => setMode(id)} className="accent-accent" data-testid={`crear-modo-${id}`} />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-muted">{mode === "auto" ? "Automático: elegimos estilo y detalles por ti; puedes cambiarlos después." : "Personalizado: tú eliges cada detalle en el siguiente paso."}</p>
      </fieldset>
      {note && <p className="mt-3 text-sm text-ink-muted" data-testid="crear-nota">{note}</p>}
      <p className="mt-3 text-xs text-ink-muted">Nada se crea ni se cobra hasta que lo autorices.</p>
      <Button type="button" size="lg" className="mt-3 w-full sm:w-auto" disabled={!!reason || going} loading={going} data-testid="crear-continuar"
        onClick={() => { if (!format || reason) return; setGoing(true); router.push(continueHref(format, idea, mode)); }}>
        Continuar
      </Button>
      {reason && <p className="mt-2 text-sm text-ink-muted" data-testid="crear-motivo">{reason}</p>}
      <nav aria-label="Accesos" className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" data-testid="crear-accesos">
        {SECONDARY_LINKS.map((l) => <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center text-ink-muted underline-offset-4 hover:text-accent hover:underline">{l.label}</Link>)}
      </nav>
      <details className="mt-2 rounded-lg border border-border px-4 py-2 text-sm" data-testid="crear-ayuda">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-ink">Ayuda: ¿cómo funciona?</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">
          <li>Elige qué crear: Reel, Podcast o Video de YouTube.</li>
          <li>Describe tu idea en una o dos frases.</li>
          <li>En el siguiente paso revisas los detalles. Antes de cualquier cobro ves el máximo y lo autorizas tú.</li>
          <li>Cuando termine, lo encuentras en «Mis proyectos» para verlo y descargarlo.</li>
        </ol>
      </details>
    </section>
  );
}
