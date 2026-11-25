/**
 * Mystery Shopper 3.0 — motor de detección. Funciones puras: reciben señales medidas por el worker
 * (navegador real, ffprobe, registros de créditos) y devuelven incidencias con módulo, severidad P0–P3,
 * evidencia, logs sanitizados, pasos para reproducir, causa raíz (solo si está confirmada) y propuesta.
 * No llama a ningún proveedor. USD 0.
 */
export type Severity = "P0" | "P1" | "P2" | "P3";
export type ModuleId = "youtube" | "audio-podcast" | "video-podcast" | "reels" | "library" | "commercial" | "account-nav" | "command-center";

export type IncidentKind =
  | "dead_button" | "frozen_screen" | "js_error" | "navigation_failure" | "endless_generation"
  | "wrong_progress" | "corrupt_file" | "wrong_duration" | "provider_failure" | "duplicate_charge"
  | "auth_error" | "mobile_layout" | "regression" | "av_desync";

export type Incident = {
  id: string;
  module: ModuleId;
  kind: IncidentKind;
  severity: Severity;
  title: string;
  evidence: string[];
  screenshot: string | null;
  logs: string[];
  repro: string[];
  /** Solo se rellena cuando la causa está confirmada por evidencia; si no, null (no se inventa). */
  rootCause: string | null;
  fixProposal: string;
};

export type Ctx = { module: ModuleId; screen: string; screenshot?: string | null; repro: string[]; secrets?: (string | undefined)[] };

// ───────────────────────── Sanitización ─────────────────────────
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const KEYLIKE = /\b(sk|pk|rk|gh[pousr]|xi|fal)[-_][A-Za-z0-9_-]{12,}\b/g;
const EMAIL = /([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const QUERY_SECRET = /([?&](?:token|access_token|refresh_token|apikey|key|code|x-vercel-protection-bypass)=)[^&\s"]+/gi;

/** Quita secretos conocidos, JWT, tokens, claves y enmascara correos. Idempotente. */
export function sanitize(text: string, secrets: (string | undefined)[] = []): string {
  let t = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("[secreto]");
  return t.replace(JWT, "[jwt]").replace(BEARER, "$1[token]").replace(KEYLIKE, "[clave]").replace(QUERY_SECRET, "$1[secreto]").replace(EMAIL, "$1***@$2").slice(0, 2000);
}

let seq = 0;
function mk(ctx: Ctx, kind: IncidentKind, severity: Severity, title: string, evidence: string[], fixProposal: string, rootCause: string | null = null, logs: string[] = []): Incident {
  seq++;
  return {
    id: `${ctx.module}-${kind}-${seq}`, module: ctx.module, kind, severity, title: sanitize(title, ctx.secrets),
    evidence: evidence.map((e) => sanitize(e, ctx.secrets)), screenshot: ctx.screenshot ?? null,
    logs: logs.map((l) => sanitize(l, ctx.secrets)).slice(0, 50), repro: [...ctx.repro, `Pantalla: ${ctx.screen}`], rootCause, fixProposal,
  };
}

// ───────────────────────── Detectores ─────────────────────────

/** Botón inoperante: tras el clic no cambió URL, DOM, red ni apareció mensaje. */
export function detectDeadButton(ctx: Ctx, s: { label: string; urlChanged: boolean; domMutations: number; requests: number; dialogOrToast: boolean; disabled: boolean; waitedMs: number }): Incident | null {
  if (s.disabled) return null; // un botón deshabilitado a la vista no es «inoperante»
  if (s.urlChanged || s.domMutations > 0 || s.requests > 0 || s.dialogOrToast) return null;
  return mk(ctx, "dead_button", "P1", `El botón «${s.label}» no hace nada`, [`Sin navegación, sin cambios en pantalla y sin peticiones durante ${s.waitedMs} ms tras el clic.`],
    "Conectar el botón a su acción o deshabilitarlo con una explicación visible.");
}

/** Pantalla congelada: la captura no cambia y el hilo principal no responde, con un indicador de carga visible. */
export function detectFrozenScreen(ctx: Ctx, s: { identicalFrames: number; frameIntervalMs: number; spinnerVisible: boolean; mainThreadBlockedMs: number }): Incident | null {
  const stuckMs = s.identicalFrames * s.frameIntervalMs;
  if (s.mainThreadBlockedMs >= 5000) return mk(ctx, "frozen_screen", "P0", "La página dejó de responder", [`Hilo principal bloqueado ${s.mainThreadBlockedMs} ms.`], "Perfilar la tarea larga (Performance) y dividirla o moverla a un worker.");
  if (s.spinnerVisible && stuckMs >= 60_000) return mk(ctx, "frozen_screen", "P1", "Pantalla congelada con indicador de carga", [`${s.identicalFrames} capturas idénticas en ${Math.round(stuckMs / 1000)} s con indicador de carga.`], "Mostrar progreso real o un error recuperable tras un límite de tiempo.");
  return null;
}

/** Errores de JavaScript: excepciones no capturadas son P1; errores de consola P2 si son muchos. */
export function detectJsErrors(ctx: Ctx, s: { pageErrors: string[]; consoleErrors: string[] }): Incident[] {
  const out: Incident[] = [];
  const ignorable = /favicon|ResizeObserver loop|Download the React DevTools/i;
  const pe = s.pageErrors.filter((e) => !ignorable.test(e));
  if (pe.length) out.push(mk(ctx, "js_error", "P1", `${pe.length} excepción(es) de JavaScript sin capturar`, pe.slice(0, 5), "Corregir la excepción y añadir un límite de error (error boundary) en la pantalla.", null, pe));
  const ce = s.consoleErrors.filter((e) => !ignorable.test(e));
  if (ce.length >= 3) out.push(mk(ctx, "js_error", "P2", `${ce.length} errores en la consola`, ce.slice(0, 5), "Revisar cada error de consola; ninguno debería aparecer en un flujo normal.", null, ce));
  return out;
}

/** Fallo de navegación: HTTP ≥ 400, timeout o redirección inesperada al login. */
export function detectNavigationFailure(ctx: Ctx, s: { url: string; httpStatus: number | null; timedOut: boolean; redirectedToLogin: boolean; authenticated: boolean }): Incident | null {
  if (s.timedOut) return mk(ctx, "navigation_failure", "P1", `La página ${s.url} no cargó a tiempo`, ["Timeout de navegación."], "Revisar tiempo de respuesta del servidor y dependencias de la página.");
  if (s.authenticated && s.redirectedToLogin) return mk(ctx, "auth_error", "P0", "La sesión se perdió al navegar", [`${s.url} devolvió al login con la sesión iniciada.`], "Revisar la renovación de cookies de Supabase en el middleware.");
  if (s.httpStatus !== null && s.httpStatus >= 500) return mk(ctx, "navigation_failure", "P0", `Error del servidor ${s.httpStatus} en ${s.url}`, [`HTTP ${s.httpStatus}`], "Revisar logs de la función en Vercel para esa ruta.");
  if (s.httpStatus !== null && s.httpStatus >= 400) return mk(ctx, "navigation_failure", "P1", `La página ${s.url} respondió ${s.httpStatus}`, [`HTTP ${s.httpStatus}`], "Corregir el enlace o la ruta.");
  return null;
}

/** Progreso: muestras {t ms, pct}. Detecta generación interminable, retrocesos, >100 % y saltos falsos 0→100. */
export function detectProgress(ctx: Ctx, samples: { t: number; pct: number | null; state?: string }[], limits: { maxTotalMs: number; maxStallMs: number }): Incident[] {
  const out: Incident[] = [];
  const v = samples.filter((x) => x.pct !== null) as { t: number; pct: number; state?: string }[];
  if (!samples.length) return out;
  const total = samples[samples.length - 1].t - samples[0].t;
  const done = samples.some((x) => /complet|terminad|listo|done|ready/i.test(x.state ?? "")) || v.some((x) => x.pct >= 100);
  if (!done && total >= limits.maxTotalMs) out.push(mk(ctx, "endless_generation", "P0", "Generación interminable", [`Sin terminar tras ${Math.round(total / 60000)} min (límite ${Math.round(limits.maxTotalMs / 60000)} min).`], "Poner un tiempo máximo en el servidor que marque la generación como fallida y devuelva créditos."));
  let stallStart: number | null = null;
  for (let i = 1; i < v.length; i++) {
    if (v[i].pct < v[i - 1].pct - 0.5) { out.push(mk(ctx, "wrong_progress", "P2", "El progreso retrocede", [`${v[i - 1].pct}% → ${v[i].pct}%`], "El indicador debe ser monótono; calcularlo desde etapas del servidor.")); break; }
  }
  if (v.some((x) => x.pct > 100 || x.pct < 0)) out.push(mk(ctx, "wrong_progress", "P2", "Progreso fuera de rango", [`Valores: ${[...new Set(v.map((x) => x.pct))].slice(0, 8).join(", ")}`], "Limitar el indicador a 0–100."));
  for (let i = 1; i < v.length; i++) {
    if (v[i].pct === v[i - 1].pct && v[i].pct < 100) { stallStart = stallStart ?? v[i - 1].t; if (v[i].t - stallStart >= limits.maxStallMs) { out.push(mk(ctx, "wrong_progress", "P1", "El progreso se queda quieto", [`${v[i].pct}% sin cambiar durante ${Math.round((v[i].t - stallStart) / 1000)} s.`], "Emitir latidos/etapas reales o explicar la espera.")); break; } }
    else stallStart = null;
  }
  if (v.length >= 2 && v[0].pct === 0 && v[v.length - 1].pct >= 100 && v.length === 2 && total < 1000) out.push(mk(ctx, "wrong_progress", "P3", "Progreso falso (0→100 instantáneo)", ["Dos muestras 0% y 100% en menos de 1 s."], "Mostrar progreso real por etapas."));
  return out;
}

/** Archivo medido con ffprobe: corrupto, duración fuera de tolerancia, silencio, formato/aspecto. */
export function detectMedia(ctx: Ctx, m: { file: string; decodeOk: boolean; container: string | null; durationSeconds: number | null; requestedSeconds: number | null; meanVolumeDb?: number | null; maxSilenceSeconds?: number | null; width?: number | null; height?: number | null; expectAspect?: "9:16" | "16:9" | null; expectKind: "mp3" | "mp4" }, tolerance = 0.1): Incident[] {
  const out: Incident[] = [];
  if (!m.decodeOk || !m.container) return [mk(ctx, "corrupt_file", "P0", `El archivo ${m.file} no se puede decodificar`, ["ffprobe/ffmpeg no lo leen."], "Validar el archivo en el servidor antes de marcarlo como listo.")];
  if (m.expectKind === "mp4" && !/mp4|mov/.test(m.container)) out.push(mk(ctx, "corrupt_file", "P1", `Se esperaba MP4 y llegó ${m.container}`, [m.container], "Exportar en contenedor MP4."));
  if (m.expectKind === "mp3" && !/mp3/.test(m.container)) out.push(mk(ctx, "corrupt_file", "P1", `Se esperaba MP3 y llegó ${m.container}`, [m.container], "Exportar en MP3."));
  if (m.durationSeconds !== null && m.requestedSeconds) {
    const diff = Math.abs(m.durationSeconds - m.requestedSeconds) / m.requestedSeconds;
    if (diff > tolerance) out.push(mk(ctx, "wrong_duration", m.durationSeconds < m.requestedSeconds * 0.5 ? "P0" : "P1", `Duración ${m.durationSeconds.toFixed(1)} s para ${m.requestedSeconds} s pedidos`, [`Desvío ${(diff * 100).toFixed(0)} % (tolerancia ${(tolerance * 100).toFixed(0)} %).`], "Ajustar guion/segmentos a la duración pedida y verificarla antes de entregar."));
  }
  if (m.meanVolumeDb !== null && m.meanVolumeDb !== undefined && m.meanVolumeDb < -50) out.push(mk(ctx, "corrupt_file", "P0", "El audio está prácticamente en silencio", [`Volumen medio ${m.meanVolumeDb} dB.`], "Comprobar mezcla de narración y música."));
  if (m.maxSilenceSeconds && m.maxSilenceSeconds > 3) out.push(mk(ctx, "corrupt_file", "P2", `Silencio de ${m.maxSilenceSeconds.toFixed(1)} s dentro del archivo`, ["silencedetect"], "Recortar o rellenar huecos entre segmentos."));
  if (m.expectAspect && m.width && m.height) {
    const r = m.width / m.height, want = m.expectAspect === "9:16" ? 9 / 16 : 16 / 9;
    if (Math.abs(r - want) > 0.02) out.push(mk(ctx, "mobile_layout", "P1", `Aspecto ${m.width}×${m.height}, se esperaba ${m.expectAspect}`, [`ratio ${r.toFixed(3)}`], "Renderizar con el lienzo correcto."));
  }
  return out;
}

/** Fallo de proveedor: respuestas ≥ 500/429 desde la API propia que nombran al proveedor, o error visible. */
export function detectProviderFailure(ctx: Ctx, events: { provider: string; status: number; message: string }[]): Incident[] {
  return events.filter((e) => e.status >= 500 || e.status === 429 || e.status === 402).map((e) => mk(ctx, "provider_failure", e.status === 402 ? "P0" : "P1", `Fallo del proveedor ${e.provider} (HTTP ${e.status})`, [e.message], e.status === 402 ? "Cuota/saldo del proveedor agotado: avisar al dueño y no cobrar créditos." : "Reintentar con backoff acotado y mostrar un error recuperable; no cobrar créditos.", null, [e.message]));
}

/** Cobros duplicados: dos cargos con la misma clave de idempotencia o mismo proyecto+acción en < ventana. */
export function detectDuplicateCharges(ctx: Ctx, charges: { id: string; key: string | null; projectId: string; action: string; amount: number; at: number }[], windowMs = 120_000): Incident[] {
  const out: Incident[] = [];
  const seenKey = new Map<string, string>();
  for (const c of charges) { if (!c.key) continue; const prev = seenKey.get(c.key); if (prev) out.push(mk(ctx, "duplicate_charge", "P0", "Cobro duplicado con la misma clave de idempotencia", [`${prev} y ${c.id} comparten clave.`], "Restricción UNIQUE sobre la clave de idempotencia y devolución automática.", "Dos cargos con la misma clave de idempotencia (confirmado por los registros).")); else seenKey.set(c.key, c.id); }
  const sorted = [...charges].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.projectId === b.projectId && a.action === b.action && b.at - a.at < windowMs && (!a.key || a.key !== b.key)) out.push(mk(ctx, "duplicate_charge", "P0", "Dos cobros de la misma acción en el mismo proyecto", [`${a.id} y ${b.id} a ${Math.round((b.at - a.at) / 1000)} s.`], "Bloquear doble envío en UI y servidor (clave de idempotencia por acción)."));
  }
  return out;
}

/** Diseño móvil: desbordamiento horizontal, objetivos táctiles pequeños, texto cortado. */
export function detectMobileLayout(ctx: Ctx, s: { viewportWidth: number; horizontalOverflowPx: number; smallTargets: number; clippedTexts?: number }): Incident[] {
  const out: Incident[] = [];
  if (s.viewportWidth > 480) return out;
  if (s.horizontalOverflowPx > 4) out.push(mk(ctx, "mobile_layout", s.horizontalOverflowPx > 40 ? "P1" : "P2", `Desbordamiento horizontal de ${s.horizontalOverflowPx}px a ${s.viewportWidth}px`, ["scrollWidth > innerWidth"], "Buscar el elemento con ancho fijo y aplicar min-w-0 / max-w-full."));
  if (s.smallTargets >= 5) out.push(mk(ctx, "mobile_layout", "P3", `${s.smallTargets} controles táctiles menores de 44 px`, ["getBoundingClientRect"], "Aumentar el área táctil a 44×44 px."));
  if (s.clippedTexts && s.clippedTexts > 0) out.push(mk(ctx, "mobile_layout", "P2", `${s.clippedTexts} textos cortados`, ["scrollWidth > clientWidth en elementos de texto"], "Permitir salto de línea o truncado con título completo."));
  return out;
}

/** Regresión: un criterio que pasó en la ejecución anterior (mismo módulo/misión) ahora falla. */
export function detectRegressions(ctx: Ctx, prev: Record<string, boolean | null>, now: Record<string, boolean | null>, prevSha: string | null, nowSha: string | null): Incident[] {
  return Object.keys(now).filter((k) => prev[k] === true && now[k] === false).map((k) => mk(ctx, "regression", "P1", `Regresión: «${k}» funcionaba y ahora falla`, [`Antes PASS en ${prevSha?.slice(0, 8) ?? "?"}; ahora FAIL en ${nowSha?.slice(0, 8) ?? "?"}.`], "Comparar el diff entre ambos SHA (git bisect) y añadir una prueba de regresión."));
}

export const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const sortIncidents = (xs: Incident[]) => [...xs].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

/** Pistas de un MP4 medidas con ffprobe: audio presente, A/V alineados (duración e inicio), video con fotogramas. */
export type AvFacts = {
  file: string;
  video: { codec: string | null; durationSeconds: number | null; startSeconds: number | null; frames: number | null; width: number | null; height: number | null } | null;
  audio: { codec: string | null; durationSeconds: number | null; startSeconds: number | null; channels: number | null } | null;
};
export function detectAv(ctx: Ctx, f: AvFacts, limits = { maxDurationGapSeconds: 0.5, maxStartGapSeconds: 0.2 }): Incident[] {
  const out: Incident[] = [];
  if (!f.video) out.push(mk(ctx, "corrupt_file", "P0", `${f.file} no tiene pista de video`, ["ffprobe: sin stream de video"], "No marcar como listo un MP4 sin video."));
  if (!f.audio) out.push(mk(ctx, "av_desync", "P0", `${f.file} no tiene pista de audio`, ["ffprobe: sin stream de audio"], "La narración/música debe mezclarse en el MP4 final; validarlo antes de entregar."));
  if (f.video && f.video.frames !== null && f.video.frames < 2) out.push(mk(ctx, "corrupt_file", "P0", `${f.file} casi no tiene fotogramas (${f.video.frames})`, ["nb_frames"], "Validar el render antes de entregar."));
  if (f.video && f.audio) {
    const vd = f.video.durationSeconds, ad = f.audio.durationSeconds;
    if (vd !== null && ad !== null && Math.abs(vd - ad) > limits.maxDurationGapSeconds) out.push(mk(ctx, "av_desync", Math.abs(vd - ad) > 3 ? "P1" : "P2", `Audio y video no duran lo mismo (${ad.toFixed(2)} s vs ${vd.toFixed(2)} s)`, [`Diferencia ${Math.abs(vd - ad).toFixed(2)} s (límite ${limits.maxDurationGapSeconds} s).`], "Ajustar la mezcla a la línea de tiempo del video (padding/trim) antes de exportar."));
    const vs = f.video.startSeconds ?? 0, as = f.audio.startSeconds ?? 0;
    if (Math.abs(vs - as) > limits.maxStartGapSeconds) out.push(mk(ctx, "av_desync", "P1", `El audio empieza desfasado ${(as - vs).toFixed(2)} s respecto al video`, [`start_time video ${vs} · audio ${as}`], "Exportar con inicio común (sin edit lists desfasadas)."));
  }
  return out;
}
