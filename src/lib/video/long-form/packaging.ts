/**
 * Presentación para YouTube de un Long Form: «Portada de apertura» (título
 * grande en los primeros segundos del video) y «Miniatura de YouTube».
 * Son opciones INDEPENDIENTES: ninguna, una o ambas.
 *
 * - En los canales propios de Hans ambas vienen activadas por defecto;
 *   para cualquier otra cuenta son opcionales (desactivadas por defecto).
 * - Todo lo que el navegador envía se revalida aquí, en el servidor, con
 *   las mismas reglas de legibilidad que usa el render
 *   (remotion/cover-rules.ts). Nunca se confía en la validación del cliente.
 * - Solo los planes v3 (visuales anclados) la aplican; v1/v2 no cambian.
 */
import { COVER_STYLE_IDS, coverErrors, validateCover, type CoverSpec, type CoverStyleId } from "../../../../remotion/cover-rules";

export type PackagingOption = { enabled: boolean; style: CoverStyleId; title: string; kicker?: string };
export type LongFormPackaging = { cover: PackagingOption; thumbnail: PackagingOption };

type EnvLike = Record<string, string | undefined>;

function emailList(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Cuentas de los canales propios de Hans: LONG_FORM_OWN_CHANNEL_EMAILS
 * (lista separada por comas) y, siempre, la cuenta dueña ya configurada
 * (AVATAR_PREPARATION_OWNER_EMAIL, la misma que da acceso a la beta).
 * Aún no existe una entidad «canal» en la base de datos: la cuenta es el canal.
 */
export function isOwnChannelAccount(user: { email?: string | null } | null, env: EnvLike = process.env): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;
  const owner = env.AVATAR_PREPARATION_OWNER_EMAIL?.trim().toLowerCase();
  return email === owner || emailList(env.LONG_FORM_OWN_CHANNEL_EMAILS).has(email);
}

/** Recorta en límite de palabra para que el título sugerido quepa (el cliente lo edita). */
export function suggestTitle(topic: string, maxChars: number): string {
  const clean = topic.replace(/\s+/g, " ").replace(/[*]/g, "").trim();
  const beforeColon = clean.split(/[:—–|]/)[0].trim();
  const candidate = beforeColon.length >= 3 ? beforeColon : clean;
  // Preserve the subject instead of cutting its name after a generic intro.
  const subject = candidate.replace(/^c[oó]mo se (?:construy[oó]|cre[oó]|fund[oó])\s+(?:(?:el|la|los|las)\s+)?/i, "");
  const base = subject.length >= 3 ? subject.charAt(0).toLocaleUpperCase("es") + subject.slice(1) : candidate;
  if (base.length <= maxChars) return base;
  const words = base.split(" ");
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || base.slice(0, maxChars);
}

export function defaultPackaging(input: { topic: string; ownChannel: boolean }): LongFormPackaging {
  return {
    cover: { enabled: input.ownChannel, style: "impacto", title: suggestTitle(input.topic, 40) },
    thumbnail: { enabled: input.ownChannel, style: "impacto", title: suggestTitle(input.topic, 32) },
  };
}

export function toCoverSpec(option: PackagingOption): CoverSpec {
  return { style: option.style, title: option.title, kicker: option.kicker?.trim() || undefined, placement: "top-right" };
}

export type PackagingValidation = { ok: true; packaging: LongFormPackaging | undefined } | { ok: false; error: string };

function parseOption(raw: unknown): PackagingOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return null;
  if (typeof o.style !== "string" || !(COVER_STYLE_IDS as string[]).includes(o.style)) return null;
  if (typeof o.title !== "string" || o.title.length > 200) return null;
  if (o.kicker !== undefined && (typeof o.kicker !== "string" || o.kicker.length > 200)) return null;
  return { enabled: o.enabled, style: o.style as CoverStyleId, title: o.title.trim(), kicker: typeof o.kicker === "string" && o.kicker.trim() ? o.kicker.trim() : undefined };
}

/**
 * Valida lo que envía el navegador. Ausente → sin presentación (nada
 * cambia). Una opción activada debe pasar las reglas de legibilidad; la
 * portada se valida en el peor caso (con rótulos de procedencia arriba a
 * la izquierda), porque la primera escena aún no se conoce.
 */
export function validatePackagingInput(raw: unknown): PackagingValidation {
  if (raw === undefined || raw === null) return { ok: true, packaging: undefined };
  if (typeof raw !== "object") return { ok: false, error: "Opciones de presentación inválidas." };
  const cover = parseOption((raw as Record<string, unknown>).cover);
  const thumbnail = parseOption((raw as Record<string, unknown>).thumbnail);
  if (!cover || !thumbnail) return { ok: false, error: "Opciones de presentación inválidas." };
  if (cover.enabled) {
    const errors = coverErrors(validateCover(toCoverSpec(cover), "video", { labelsTopLeft: true }));
    if (errors.length) return { ok: false, error: `Portada de apertura: ${errors.map((e) => e.message).join(" ")}` };
  }
  if (thumbnail.enabled) {
    const errors = coverErrors(validateCover(toCoverSpec(thumbnail), "thumbnail"));
    if (errors.length) return { ok: false, error: `Miniatura: ${errors.map((e) => e.message).join(" ")}` };
  }
  return { ok: true, packaging: cover.enabled || thumbnail.enabled ? { cover, thumbnail } : undefined };
}

export function isLongFormPackaging(value: unknown): value is LongFormPackaging {
  const v = validatePackagingInput(value);
  return v.ok && v.packaging !== undefined;
}

/** Ruta canónica de la miniatura, junto al video final (ver output-finalize.ts). */
export const canonicalThumbnailPath = (requestId: string) => `${requestId}/output/thumbnail.jpg`;
