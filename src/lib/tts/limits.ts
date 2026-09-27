/**
 * Límites de «Texto a voz» en tres capas que NO se mezclan:
 *
 * 1. Capacidad técnica por trabajo (TTS_TECHNICAL_MAX_CHARS): lo máximo que
 *    el sistema sabe procesar en una pieza (tabla, worker, archivos). No es
 *    una cuota: nadie la recibe automáticamente.
 * 2. Límite de cada usuario: por pieza y por mes. Los usuarios generales
 *    siguen con TTS_MAX_CHARS_PER_PIECE / TTS_MAX_CHARS_PER_USER_MONTH. Los
 *    episodios largos son un piloto: solo las cuentas de la lista y solo con
 *    límites explícitos (sin ellos, el piloto está apagado).
 * 3. Saldo real del proveedor: lo consulta el worker antes de gastar (y
 *    durante un episodio largo); aquí solo se decide cuánto dejar libre
 *    para Reel, Avatar y Long Form, que usan la misma cuenta.
 *
 * Lógica pura, sin I/O.
 */
type EnvLike = Record<string, string | undefined>;

/** Igual al CHECK de tts_jobs.script en la migración 0022 (no subir sin otra migración). */
export const TTS_TECHNICAL_MAX_CHARS = 60000;

/** Caracteres que un episodio largo deja sin usar en la cuenta del proveedor para el resto del producto. */
export const DEFAULT_PROVIDER_RESERVE_CHARS = 3000;

export type TtsLimitProfile = {
  kind: "general" | "long_pilot";
  maxCharsPerPiece: number;
  maxCharsPerUserMonth: number;
  /** Solo piloto: caracteres del proveedor que deben quedar libres después de la pieza. */
  providerReserveChars: number;
};

const list = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const positiveInt = (raw: string | undefined): number | null => {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function isLongPilotUser(user: { id?: string | null; email?: string | null } | null | undefined, env: EnvLike = process.env): boolean {
  if (!user) return false;
  const ids = list(env.TTS_LONG_PILOT_USER_IDS);
  const emails = list(env.TTS_LONG_PILOT_EMAILS);
  return Boolean((user.id && ids.has(user.id.toLowerCase())) || (user.email && emails.has(user.email.toLowerCase())));
}

/**
 * Límites que valen para esta cuenta. El piloto exige, además de estar en
 * la lista, TTS_LONG_PILOT_MAX_CHARS_PER_PIECE y
 * TTS_LONG_PILOT_MAX_CHARS_PER_MONTH explícitos; ambos se recortan a la
 * capacidad técnica. Si falta algo, la cuenta usa los límites generales.
 */
export function resolveTtsLimits(
  user: { id?: string | null; email?: string | null } | null | undefined,
  general: { maxCharsPerPiece: number; maxCharsPerUserMonth: number },
  env: EnvLike = process.env,
): TtsLimitProfile {
  const base: TtsLimitProfile = {
    kind: "general",
    maxCharsPerPiece: Math.min(general.maxCharsPerPiece, TTS_TECHNICAL_MAX_CHARS),
    maxCharsPerUserMonth: general.maxCharsPerUserMonth,
    providerReserveChars: 0,
  };
  if (!isLongPilotUser(user, env)) return base;
  const piece = positiveInt(env.TTS_LONG_PILOT_MAX_CHARS_PER_PIECE);
  const month = positiveInt(env.TTS_LONG_PILOT_MAX_CHARS_PER_MONTH);
  if (!piece || !month) return base;
  const reserveRaw = env.TTS_PROVIDER_RESERVE_CHARS?.trim();
  const reserve = reserveRaw && /^\d+$/.test(reserveRaw) ? Number(reserveRaw) : DEFAULT_PROVIDER_RESERVE_CHARS;
  return {
    kind: "long_pilot",
    maxCharsPerPiece: Math.max(base.maxCharsPerPiece, Math.min(piece, TTS_TECHNICAL_MAX_CHARS)),
    maxCharsPerUserMonth: Math.max(base.maxCharsPerUserMonth, month),
    providerReserveChars: reserve,
  };
}

/** Una pieza es «larga» (piloto) si supera el máximo general por pieza. */
export function isLongPiece(characters: number, generalMaxCharsPerPiece: number): boolean {
  return characters > generalMaxCharsPerPiece;
}

/** Caracteres de otras piezas en curso que el worker descuenta del saldo antes de gastar (conservador: la pieza entera). */
export function reservedByOthers(rows: { characters: number }[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.characters) || 0), 0);
}

/**
 * ¿Alcanza el saldo del proveedor para lo que falta? `reserve` solo se exige
 * a los episodios largos (deja margen para el resto del producto, que no
 * reserva caracteres: Reel, Avatar y Long Form consumen sin avisar).
 */
export function providerHasRoom(input: { remaining: number; needed: number; othersReserved: number; reserve: number }): boolean {
  return input.remaining - input.othersReserved - input.reserve >= input.needed;
}
