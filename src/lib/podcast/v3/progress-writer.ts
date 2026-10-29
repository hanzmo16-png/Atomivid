/**
 * Podcast — escritura del avance del estudio (worker).
 *
 * Incidente ec30c594 (2026-10-29): el worker escribía con `void service.from(...).update(...)`. Las consultas de
 * Supabase son perezosas: la petición solo sale al llamar `.then()` (o `await`), así que ningún avance llegó a la base
 * y la página se quedó en 0 % mientras se pagaban voces, imágenes y clips. Aquí cada escritura se ESPERA, de una en una
 * (la última pendiente reemplaza a las anteriores: no se acumulan peticiones), el avance nunca retrocede
 * (mergeProgress) y un fallo de escritura se registra sin detener la producción (el avance no vale un episodio).
 */
import { mergeProgress, type StudioProgress } from "./progress";

export type PersistResult = { error?: { message?: string } | null; count?: number | null } | void;

export function createProgressWriter(persist: (p: StudioProgress) => PromiseLike<PersistResult>, log: (line: string) => void = console.log) {
  let last: StudioProgress | null = null;
  let pending: StudioProgress | null = null;
  let running: Promise<void> | null = null;
  let failures = 0;
  let writes = 0;
  const drain = async () => {
    while (pending) {
      const p = pending;
      pending = null;
      try {
        const r = await persist(p);
        if (r && r.error) throw new Error(r.error.message ?? "error");
        writes++;
      } catch (e) {
        // Una sola línea por racha de fallos (sin datos del episodio ni secretos).
        if (failures++ === 0) log(`STUDIO_PROGRESS_WRITE_FAILED ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
      }
    }
    running = null;
  };
  const schedule = (p: StudioProgress) => { pending = p; if (!running) running = drain(); };
  return {
    /** Un avance real del pipeline: se une al anterior (sin retroceder) y se guarda. */
    push(next: StudioProgress) { last = mergeProgress(last, next); schedule(last); },
    /** Latido: el mismo avance con la hora actual (la página distingue «trabajando» de «sin respuesta»). */
    beat(now = new Date()) { if (last) { last = { ...last, updatedAt: now.toISOString() }; schedule(last); } },
    /** Espera a que lo pendiente esté guardado (antes del «ready» o del «failed», que escriben la misma fila). */
    async flush() { while (running) await running; },
    get last() { return last; },
    get stats() { return { writes, failures }; },
  };
}
