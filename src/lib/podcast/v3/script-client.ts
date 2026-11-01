/**
 * Cliente del guion con IA por bloques (navegador). Incidente 2026-11-01 («BASE DULCE»): tras un error, «Empezar de
 * nuevo» dejó el guion vacío, «No se pudo conectar con el servidor» y aun así «Continuar la conversación (bloque 1 de 3)».
 * Causas: (1) toda excepción de fetch se mostraba como falta de internet; (2) el bucle de bloques no se podía cancelar
 * y su respuesta tardía volvía a escribir el trabajo viejo en el borrador nuevo; (3) sin tiempo límite ni reintento.
 *
 * Aquí, una sola función pura (fetch y espera inyectables) que:
 *  - distingue red, tiempo agotado, HTTP, sesión, proveedor, presupuesto, validación, paso en curso y respuesta
 *    incompleta, con un mensaje claro y si se puede retomar;
 *  - reintenta SOLO lo transitorio y SIEMPRE con el mismo estado: el servidor usa una clave determinista por trabajo,
 *    paso e intento, así que un reintento reutiliza lo ya pagado o encuentra el paso en curso (nunca cobra dos veces);
 *  - si el paso sigue ejecutándose en el servidor (409 «in-flight»), espera y vuelve a consultar en vez de duplicarlo;
 *  - se cancela con una señal: después de cancelar no escribe nada (ni estado ni progreso).
 */
export type ScriptAsk = { topic: string; minutes: number; hostName: string; guestName: string; guestRole?: string; hostPersonality?: string; guestPersonality?: string };
export type ScriptProgress = { step: number; steps: number; phase: "escaleta" | "bloque" | "ampliando"; note?: string; waiting?: string };
export type ScriptFailure = "red" | "tiempo" | "http" | "sesion" | "proveedor" | "presupuesto" | "validacion" | "en-curso" | "incompleta" | "cancelado" | "agotado";
export type ScriptRunResult =
  | { kind: "done"; script: string; note: string; estimatedMinutes: number; withinTarget: boolean }
  | { kind: "error"; reason: ScriptFailure; message: string; recoverable: boolean; status?: number };

export type ScriptClientDeps = {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Estado del trabajo a guardar en el borrador (null = descartarlo porque ya no se puede retomar). */
  onState: (state: unknown | null) => void;
  onProgress: (p: ScriptProgress | null) => void;
  signal?: AbortSignal;
  /** Tiempo máximo de una petición (un bloque tarda 40–90 s; la función, como mucho 300 s). */
  timeoutMs?: number;
  maxTransientRetries?: number;
  maxInFlightWaits?: number;
  maxInvalidRetries?: number;
};

const where = (state: unknown) => {
  const s = state as { plan?: { segments?: unknown[] } | null; segments?: unknown[] } | null;
  const n = s?.plan?.segments?.length;
  return n ? `bloque ${(s?.segments?.length ?? 0) + 1} de ${n}` : "la escaleta";
};

type Reply = { status: number; ok: boolean; body: Record<string, unknown> | null; failure?: "red" | "tiempo" | "cancelado" };

async function call(d: ScriptClientDeps, payload: unknown): Promise<Reply> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, d.timeoutMs ?? 330_000);
  const onAbort = () => ctl.abort();
  d.signal?.addEventListener("abort", onAbort);
  try {
    const res = await d.fetchImpl("/api/podcast/v3", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
    let body: Record<string, unknown> | null = null;
    try { const t = await res.text(); body = t ? JSON.parse(t) : null; } catch { body = null; }
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) body = null;
    return { status: res.status, ok: res.ok, body };
  } catch {
    if (d.signal?.aborted) return { status: 0, ok: false, body: null, failure: "cancelado" };
    return { status: 0, ok: false, body: null, failure: timedOut ? "tiempo" : "red" };
  } finally {
    clearTimeout(timer);
    d.signal?.removeEventListener("abort", onAbort);
  }
}

/** Genera (o continúa) el guion con IA hasta terminar, cancelar o dar un error que la persona deba ver. */
export async function runScriptGeneration(ask: ScriptAsk, initial: unknown | null, d: ScriptClientDeps): Promise<ScriptRunResult> {
  let state = initial ?? null, transient = 0, inFlight = 0, invalid = 0;
  const cancelled = (): ScriptRunResult => ({ kind: "error", reason: "cancelado", message: "Generación cancelada.", recoverable: true });
  for (let guard = 0; guard < 80; guard++) {
    if (d.signal?.aborted) return cancelled();
    const r = await call(d, { action: "script-step", ...ask, state });
    if (d.signal?.aborted || r.failure === "cancelado") return cancelled();
    const b = r.body ?? {};
    // El estado que devuelve el servidor (también en errores recuperables) es el progreso real: se guarda.
    if (b.state !== undefined && b.state !== null) { state = b.state; d.onState(state); }
    if (r.ok && b.state !== undefined) {
      transient = 0; inFlight = 0;
      const progress: ScriptProgress = { step: Number(b.step) || 0, steps: Number(b.steps) || 0, phase: (b.phase as ScriptProgress["phase"]) ?? "bloque", ...(b.stepNote ? { note: String(b.stepNote) } : {}) };
      if (b.done === true) {
        if (typeof b.script !== "string" || !b.script.trim()) return { kind: "error", reason: "incompleta", message: `El servidor terminó sin devolver el guion; tu progreso (${where(state)}) está guardado. Pulsa «Continuar».`, recoverable: true };
        d.onProgress(null); d.onState(null);
        return { kind: "done", script: b.script, note: String(b.note ?? "Conversación generada con IA. Revísala antes de seguir."), estimatedMinutes: Number(b.estimatedMinutes) || 0, withinTarget: b.withinTarget === true };
      }
      d.onProgress(progress);
      continue;
    }
    const retryTransient = async (msg: string, reason: "red" | "tiempo" | "http") => {
      if (transient >= (d.maxTransientRetries ?? 2)) return { kind: "error" as const, reason, message: `${msg} Tu progreso (${where(state)}) está guardado: pulsa «Continuar la conversación» para retomarlo; no se cobrará dos veces.`, recoverable: true, ...(r.status ? { status: r.status } : {}) };
      transient++;
      d.onProgress({ step: 0, steps: 0, phase: "bloque", waiting: `${msg} Reintentando (${transient} de ${d.maxTransientRetries ?? 2})…` });
      await d.sleep(5000 * transient);
      return null;
    };
    // Sin respuesta: red caída o tiempo agotado. El paso pudo completarse en el servidor: el reintento lo reutiliza.
    if (r.failure === "red") { const e = await retryTransient("Se interrumpió la conexión con el servidor.", "red"); if (e) return e; continue; }
    if (r.failure === "tiempo") { const e = await retryTransient("El servidor tardó demasiado en responder.", "tiempo"); if (e) return e; continue; }
    const code = String(b.code ?? ""), detail = String(b.detail ?? ""), serverMsg = typeof b.error === "string" ? b.error : null;
    if (r.status === 401 || r.status === 403) return { kind: "error", reason: "sesion", message: `Tu sesión expiró o no tiene acceso. Inicia sesión de nuevo: tu progreso (${where(state)}) sigue guardado en este navegador.`, recoverable: true, status: r.status };
    if (r.status === 409 && detail === "in-flight") {
      // El mismo paso se está ejecutando (otra pestaña o una petición anterior que el navegador dejó de esperar).
      if (inFlight >= (d.maxInFlightWaits ?? 8)) return { kind: "error", reason: "en-curso", message: `El ${where(state)} sigue marcado como en curso en el servidor. Espera un minuto y pulsa «Continuar» (no se generará dos veces); si después de varios minutos sigue igual, la llamada quedó sin confirmar: pulsa «Empezar de nuevo» para escribir un guion nuevo.`, recoverable: true, status: 409 };
      inFlight++;
      d.onProgress({ step: 0, steps: 0, phase: "bloque", waiting: `El ${where(state)} sigue generándose en el servidor; esperando el resultado…` });
      await d.sleep(20_000);
      continue;
    }
    if (code === "INVALIDO" && b.recoverable === true && invalid < (d.maxInvalidRetries ?? 1)) {
      // Respuesta del modelo que no sirvió: el servidor ya contó el intento; se pide otro (acotado por paso en el servidor).
      invalid++;
      d.onProgress({ step: 0, steps: 0, phase: "bloque", waiting: `${serverMsg ?? "La respuesta no sirvió."} Reintentando…` });
      continue;
    }
    if (b.recoverable === false) { state = null; d.onState(null); }
    d.onProgress(null);
    if (code === "LIMITE_DIARIO") return { kind: "error", reason: "presupuesto", message: serverMsg ?? "Alcanzaste el límite diario de guiones con IA.", recoverable: true, status: r.status };
    if (code === "IA_FALLO" && detail.startsWith("supply:")) return { kind: "error", reason: "presupuesto", message: serverMsg ?? "El control de gasto no admitió la llamada.", recoverable: true, status: r.status };
    if (code === "IA_FALLO" || code === "IA_NO_DISPONIBLE") return { kind: "error", reason: "proveedor", message: serverMsg ?? "El modelo no respondió.", recoverable: code === "IA_FALLO", status: r.status };
    if (code === "INVALIDO") return { kind: "error", reason: "validacion", message: serverMsg ?? "La respuesta del modelo no sirvió.", recoverable: true, status: r.status };
    if (code === "AGOTADO" || code === "ESTADO") return { kind: "error", reason: "agotado", message: serverMsg ?? "No se pudo completar el guion; empieza uno nuevo.", recoverable: false, status: r.status };
    if (r.status >= 500 || r.body === null) {
      // 500/502/504 o una página que no es JSON (p. ej. tiempo límite de la plataforma): transitorio, mismo estado.
      const e = await retryTransient(`El servidor respondió con un error (${r.status || "sin respuesta"}).`, "http");
      if (e) return e;
      continue;
    }
    return { kind: "error", reason: "http", message: serverMsg ?? `Error inesperado del servidor (${r.status}).`, recoverable: b.recoverable !== false, status: r.status };
  }
  return { kind: "error", reason: "http", message: `La generación no terminó; tu progreso (${where(state)}) está guardado. Pulsa «Continuar».`, recoverable: true };
}
