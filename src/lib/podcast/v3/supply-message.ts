/**
 * Mensajes de bloqueo del control de suministro de la IA con su restablecimiento REAL (incidente «Base Dulce»,
 * 2026-11-02: «máximo diario de llamadas» + «reintenta en unos minutos», cuando en realidad se restablece a medianoche).
 * La cuota la aplica la base de datos (pi_submit_with_supply → pi_supply_state): `max_daily_calls` por proveedor, contando
 * TODA llamada de ese proveedor (cualquier producto y cuenta) creada desde las 00:00 de la zona de la política y que no
 * quedó solo reservada; una respuesta rechazada por calidad ya se pagó y cuenta. Puro (sin red): la política se inyecta.
 */
export type SupplyPolicyInfo = { maxDailyCalls: number; timezone: string; dailyCapUsd?: number | null; monthlyCapUsd?: number | null };

const ZONE_LABEL: Record<string, string> = { "America/Cancun": "Cancún", "America/Mexico_City": "Ciudad de México", UTC: "UTC" };

/** Partes de fecha/hora locales de `now` en `tz`, y el desfase local−UTC en ms. */
function localParts(tz: string, now: Date) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  const asUtc = Date.UTC(y, m - 1, d, Number(p.hour), Number(p.minute), Number(p.second));
  return { y, m, d, offsetMs: asUtc - Math.floor(now.getTime() / 1000) * 1000 };
}
/** Próximas 00:00 locales (día siguiente) en `tz`. */
export function nextLocalMidnight(tz: string, now: Date): Date {
  const { y, m, d, offsetMs } = localParts(tz, now);
  return new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetMs);
}
/** Día 1 del mes siguiente, 00:00 locales. */
export function nextLocalMonthStart(tz: string, now: Date): Date {
  const { y, m, offsetMs } = localParts(tz, now);
  return new Date(Date.UTC(y, m, 1, 0, 0, 0) - offsetMs);
}
const hhmmUtc = (t: Date) => t.toISOString().slice(11, 16);
/** Fecha LOCAL (AAAA-MM-DD) del instante `t` en `tz`. No usar toISOString: en zonas UTC+ daría el día anterior. */
export function localDate(tz: string, t: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}
const until = (t: Date, now: Date) => {
  const min = Math.max(1, Math.ceil((t.getTime() - now.getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
};

/**
 * Mensaje para la persona según el motivo del control (`reason` de pi_submit_with_supply) y la política vigente.
 * Devuelve también `resetAt` (ISO) cuando hay una hora fija de restablecimiento; nunca promete «unos minutos».
 */
export function supplyBlockMessage(reason: string, policy: SupplyPolicyInfo | null, now = new Date()): { error: string; resetAt: string | null } {
  const tz = policy?.timezone || "America/Cancun", zone = ZONE_LABEL[tz] ?? tz;
  const keep = "No se cobró nada y lo ya escrito queda guardado en este navegador";
  if (reason === "daily request quota") {
    const at = nextLocalMidnight(tz, now);
    const what = `la plataforma ya hizo hoy sus ${policy?.maxDailyCalls ?? "N"} llamadas de IA permitidas. Es un límite diario compartido por toda la plataforma; cada escaleta, bloque, ampliación o reintento cuenta como una llamada, también una respuesta rechazada por calidad`;
    return { error: `La IA no pudo empezar: ${what}. Se restablece a las 00:00 hora de ${zone} (${hhmmUtc(at)} UTC, dentro de ${until(at, now)}). ${keep}: pulsa «Continuar la conversación» después de esa hora; no se repetirá lo ya pagado.`, resetAt: at.toISOString() };
  }
  if (reason === "provider funded spend ceiling" || reason === "global funded spend ceiling") {
    // El motivo no dice si se agotó el tope DIARIO o el MENSUAL: no se inventa una hora (resetAt null) y se explican ambas.
    const day = nextLocalMidnight(tz, now), month = nextLocalMonthStart(tz, now);
    const scope = reason === "global funded spend ceiling" ? "de toda la plataforma" : "de este proveedor de IA";
    return { error: `La IA no pudo empezar: se alcanzó un tope de gasto de IA ${scope}. Puede ser el tope diario o el mensual, y este aviso no indica cuál. Si es el diario, se restablece a las 00:00 hora de ${zone} (${hhmmUtc(day)} UTC); si es el mensual, el ${localDate(tz, month)} a las 00:00 hora de ${zone}. ${keep}: pulsa «Continuar la conversación» más tarde; si sigue bloqueado tras la medianoche, es el tope mensual y lo resuelve el operador de la plataforma.`, resetAt: null };
  }
  if (reason === "concurrency") return { error: `La IA no pudo empezar: otra llamada de IA de la plataforma está en curso (solo se admite una a la vez; cada llamada dura como máximo 5 minutos). ${keep}: pulsa «Continuar la conversación» cuando termine.`, resetAt: null };
  return { error: `La IA no pudo empezar: el control de gasto no admitió la llamada (${reason || "motivo no informado"}). No hay una hora fija de restablecimiento: lo resuelve el operador de la plataforma. ${keep}.`, resetAt: null };
}
