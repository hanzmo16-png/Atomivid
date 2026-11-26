"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ProjectView } from "@/lib/audio-studio/service";
import { blockCount, stepsDone, totalSteps, type ScriptJob } from "@/lib/audio-studio/script-ai";

export type ScriptAiState = { available: true } | { available: false; reason: string };

/** Etiqueta del paso en curso según el progreso GUARDADO en el servidor (no un tiempo simulado). */
export function scriptPhaseLabel(j: ScriptJob): string {
  const n = blockCount(j.input.minutes);
  if (!j.plan) return "Diseñando la estructura temática del episodio…";
  const k = j.blocks.length;
  if (k >= n) return "Uniendo el guion…";
  return `Escribiendo la parte ${k + 1} de ${n}: «${j.plan.blocks[k]?.title ?? ""}»…`;
}

/**
 * Escritura del guion completo con IA a partir del tema (título), las notas de dirección, la duración, el idioma y las
 * voces. El navegador pide los pasos de uno en uno; el porcentaje sale de los pasos terminados que guarda el servidor.
 * Si la página se recarga a mitad, el trabajo se retoma desde el último paso guardado (lo pagado no se repite).
 */
export function AiScriptPanel({ project, ai, dirty, blocked, save, onProject }: {
  project: ProjectView; ai: ScriptAiState; dirty: boolean; blocked: boolean;
  save: () => Promise<ProjectView | null>; onProject: (p: ProjectView) => void;
}) {
  const job = project.scriptJob ?? null;
  const running = job?.status === "en_curso";
  const [looping, setLooping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const loopRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch(`/api/audio-studio/projects/${project.id}/guion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(320_000) });
    const body = await res.json().catch(() => null);
    return { res, body };
  }, [project.id]);

  /** Pide pasos hasta terminar. Una respuesta inválida de la IA se reintenta sola (el servidor limita los intentos). */
  const loop = useCallback(async (jobId: string) => {
    if (loopRef.current) return;
    loopRef.current = true; setLooping(true); setError(null);
    try {
      for (let guard = 0; guard < 40 && alive.current; guard++) {
        let r: { res: Response; body: { error?: string; code?: string; scriptStep?: { done: boolean }; current?: ProjectView; scriptJob?: ScriptJob } | null };
        try { r = await post({ action: "paso", jobId }); }
        catch { setError("Se perdió la conexión mientras la IA escribía. Lo ya escrito está guardado: pulsa «Continuar»."); return; }
        const { res, body } = r;
        if (res.ok && body?.scriptJob) {
          onProject(body as unknown as ProjectView);
          if (body.scriptStep?.done || body.scriptJob.status !== "en_curso") return;
          continue;
        }
        if (body?.current) onProject(body.current);
        if (res.status === 422 && body?.code === "INVALIDO") continue; // la IA reintenta ese mismo paso
        if (body?.code === "SIN_TRABAJO") return; // se canceló mientras se escribía el paso
        if (res.status === 409 && body?.code === "PASO_EN_CURSO") { await new Promise((ok) => setTimeout(ok, 5000)); continue; } // paso en curso en otra pestaña
        setError(body?.error ?? "La IA no pudo continuar. Lo ya escrito se conserva: pulsa «Continuar».");
        return;
      }
    } finally { loopRef.current = false; if (alive.current) setLooping(false); }
  }, [post, onProject]);

  // Al abrir el episodio con un guion a medias, se retoma solo (desde el último paso guardado).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !running || !job || !ai.available) return;
    resumed.current = true;
    void loop(job.jobId);
  }, [running, job, ai.available, loop]);

  async function start() {
    setConfirmReplace(false); setError(null);
    let cur = project;
    if (dirty) { const s = await save(); if (!s) return; cur = s; }
    let r;
    try { r = await post({ action: "iniciar", revision: cur.revision }); } catch { setError("Sin conexión. No se empezó nada ni se cobró nada."); return; }
    if (!r.res.ok || !r.body?.scriptJob) { if (r.body?.current) onProject(r.body.current); setError(r.body?.error ?? "No se pudo empezar."); return; }
    onProject(r.body as ProjectView);
    await loop(r.body.scriptJob.jobId);
  }

  async function cancel() {
    const r = await post({ action: "cancelar" }).catch(() => null);
    if (r?.res.ok && r.body) onProject(r.body as ProjectView);
  }

  if (!ai.available) {
    return <p className="rounded-md border border-border bg-surface-raised p-3 text-sm text-ink-muted" data-testid="audio-ai-off">{ai.reason}</p>;
  }

  if (running && job) {
    const done = stepsDone(job), total = totalSteps(job), percent = Math.floor((done / total) * 100);
    return (
      <div className="space-y-2 rounded-md border border-accent-border bg-surface-raised p-4" data-testid="audio-ai-progress" role="status" aria-live="polite">
        <p className="text-sm font-semibold text-ink">{looping ? "La IA está escribiendo tu guion" : "Escritura del guion en pausa"} · {percent}%</p>
        <div className="h-2 w-full overflow-hidden rounded bg-surface" role="progressbar" aria-label="Avance del guion con IA" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-2 rounded bg-accent transition-all" style={{ width: `${Math.max(4, percent)}%` }} />
        </div>
        <p className="text-xs text-ink-muted" data-testid="audio-ai-phase">Paso {Math.min(done + 1, total)} de {total} · {scriptPhaseLabel(job)}</p>
        <p className="text-xs text-ink-muted">Cada parte tarda entre 30 segundos y 2 minutos. Puedes salir: el avance se guarda y se retoma al volver.</p>
        {job.note && <p className="text-xs text-ink-muted" data-testid="audio-ai-note">{job.note}</p>}
        {error && <p role="alert" className="text-sm text-danger" data-testid="audio-ai-error">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {!looping && <Button type="button" className="min-h-11" data-testid="audio-ai-continue" onClick={() => void loop(job.jobId)}>Continuar</Button>}
          <Button type="button" variant="ghost" className="min-h-11" data-testid="audio-ai-cancel" onClick={() => void cancel()}>Cancelar</Button>
        </div>
      </div>
    );
  }

  const hasScript = project.script.trim().length > 0;
  return (
    <div className="space-y-2" data-testid="audio-ai">
      {confirmReplace ? (
        <div role="alertdialog" aria-label="Reemplazar el guion" className="space-y-2 rounded-md border border-warning bg-surface-raised p-3 text-sm text-ink" data-testid="audio-ai-confirm">
          <p>La IA escribirá un guion nuevo y reemplazará el actual. ¿Continuar?</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" data-testid="audio-ai-confirm-yes" onClick={() => void start()}>Sí, escribir uno nuevo</Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setConfirmReplace(false)}>No</Button>
          </div>
        </div>
      ) : (
        <Button type="button" className="min-h-11 w-full sm:w-auto" data-testid="audio-ai-write" disabled={blocked || looping}
          onClick={() => (hasScript ? setConfirmReplace(true) : void start())}>
          {hasScript ? "Reescribir el guion con IA" : "Escribir el guion completo con IA"}
        </Button>
      )}
      <p className="text-xs text-ink-muted">Usa el título como tema, tus notas de dirección, la duración, el idioma y las voces elegidas. No consume créditos de voz; el audio se genera después, con tu autorización.</p>
      {job?.status === "terminado" && job.result && (
        <p className="text-xs text-ink-muted" data-testid="audio-ai-done">
          Guion escrito con IA: {job.result.words.toLocaleString("es")} palabras, ≈ {String(job.result.estimatedMinutes).replace(".", ",")} min para {job.input.minutes} pedidos.
          {job.result.withinTarget ? " Revísalo y edítalo si quieres antes de generar el audio." : " La duración se aleja de lo pedido: puedes reescribirlo o ajustarlo a mano."}
        </p>
      )}
      {job?.status === "fallido" && job.error && <p role="alert" className="text-sm text-danger" data-testid="audio-ai-error">{job.error}</p>}
      {error && <p role="alert" className="text-sm text-danger" data-testid="audio-ai-error">{error}</p>}
    </div>
  );
}
