/**
 * Podcast 3.0 — planificador editorial DETERMINISTA (misma entrada → mismo plan, sin red).
 * Decide por turno qué se ve: avatar hablando, segundo participante, two-shot, sobre el hombro, imagen documental,
 * recreación (etiquetada «Recreación»), archivo o transición. Reglas:
 *  - VERACIDAD: una recreación nunca se presenta como evidencia; siempre lleva la etiqueta en pantalla.
 *  - Coherencia: la imagen de un turno se elige por palabras del propio turno (sin escenas ajenas al diálogo);
 *    nunca la misma imagen dos veces en el episodio salvo que la biblioteca se agote (se informa).
 *  - Sin saltos incoherentes: no se pasa de un plano de avatar a otro del MISMO tipo y hablante distinto sin
 *    two-shot/transición; las apariciones del avatar respetan frecuencia y duración máxima (costo).
 */
import type { StudioMode } from "./spec";
import { estimateSeconds, type Turn } from "./script";

export type ShotKind = "avatar_a" | "avatar_b" | "two_shot" | "over_shoulder" | "imagen" | "recreacion" | "archivo" | "transicion" | "titulo";
export type VisualAsset = { id: string; query: string; kind: "foto" | "archivo" | "recreacion"; tags: string[]; credit?: string };
export type Shot = {
  turn_id: string | null; speaker: "A" | "B" | null; kind: ShotKind; start: number; end: number;
  asset_id?: string; label?: "Recreación" | "Archivo"; reason: string;
  /** En sobre el hombro: quién mira a cámara (habla) y quién queda de espaldas. */
  facing?: "A" | "B";
};
export type PlanInput = {
  mode: StudioMode; turns: (Turn & { seconds?: number })[]; assets: VisualAsset[];
  avatarFrequency: number; avatarMaxSeconds: number; recreations: boolean; hasAvatar: { A: boolean; B: boolean };
  introSeconds?: number;
};
export type EditorialPlan = { shots: Shot[]; issues: string[]; avatarSeconds: { A: number; B: number }; assetsUsed: string[] };

const STOP = new Set("de la el los las un una y o que en a por para con se su sus es son lo al del como más pero sus este esta eso esa muy ya no sí si le les me te nos hay fue era ser hace hoy aquí allí the of and to in is".split(" "));
export const keywords = (text: string) => [...new Set(text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9ñ]+/).filter((w) => w.length > 3 && !STOP.has(w)))];

/** Mejor recurso NO usado para el turno; puntuación = coincidencias de palabras clave; empate → id (estable). */
export function pickAsset(text: string, assets: VisualAsset[], used: Set<string>, allowRecreation: boolean): { asset: VisualAsset; score: number } | null {
  const kw = new Set(keywords(text));
  const scored = assets.filter((a) => !used.has(a.id) && (allowRecreation || a.kind !== "recreacion"))
    .map((a) => ({ asset: a, score: [...new Set([...a.tags.map((t) => t.toLowerCase()), ...keywords(a.query)])].filter((t) => kw.has(t)).length }))
    .filter((x) => x.score >= 1)
    // VERACIDAD: material real (foto/archivo) antes que una recreación; luego más coincidencias; empate → id (estable).
    .sort((x, y) => Number(x.asset.kind === "recreacion") - Number(y.asset.kind === "recreacion") || y.score - x.score || x.asset.id.localeCompare(y.asset.id));
  return scored[0] ?? null;
}

export function planEpisode(input: PlanInput): EditorialPlan {
  const shots: Shot[] = [];
  const issues: string[] = [];
  const used = new Set<string>();
  const avatarSeconds = { A: 0, B: 0 };
  let t = input.introSeconds ?? 0;
  if (t > 0) shots.push({ turn_id: null, speaker: null, kind: "titulo", start: 0, end: t, reason: "Apertura con título y cortina musical." });
  const n = input.turns.length;
  // Frecuencia: el avatar aparece en ~freq de los turnos, repartido de forma uniforme (acumulador determinista).
  // Arranca de modo que el primer turno lo presente el avatar (B/C).
  let acc = 1 - input.avatarFrequency;
  let lastKind: ShotKind | null = null;
  input.turns.forEach((turn, i) => {
    const dur = turn.seconds ?? estimateSeconds(turn.text);
    const start = t, end = t + dur;
    acc += input.avatarFrequency;
    const wantsAvatar = input.mode !== "narracion" && acc >= 1 - 1e-9 && input.hasAvatar[turn.speaker];
    if (wantsAvatar) acc -= 1;
    const visual = () => {
      const pick = pickAsset(turn.text, input.assets, used, input.recreations);
      if (pick) {
        used.add(pick.asset.id);
        const kind: ShotKind = pick.asset.kind === "recreacion" ? "recreacion" : pick.asset.kind === "archivo" ? "archivo" : "imagen";
        return { kind, asset_id: pick.asset.id, ...(kind === "recreacion" ? { label: "Recreación" as const } : kind === "archivo" ? { label: "Archivo" as const } : {}), reason: `Imagen relacionada con el turno (${pick.score.toFixed(0)} coincidencias).` };
      }
      return null;
    };
    let shot: Omit<Shot, "turn_id" | "speaker" | "start" | "end">;
    if (input.mode === "narracion") {
      shot = visual() ?? { kind: "transicion", reason: "Sin imagen relacionada sin repetir: se usa un plano de transición (no una imagen ajena)." };
    } else if (wantsAvatar) {
      const capped = Math.min(dur, input.avatarMaxSeconds);
      if (input.mode === "dialogo" && input.hasAvatar.A && input.hasAvatar.B) {
        // Variedad editorial en conversación: pregunta → sobre el hombro (quien pregunta de espaldas); reacción/comentario corto → two-shot; resto → primer plano.
        const kind: ShotKind = turn.kind === "pregunta" ? "over_shoulder" : (turn.kind === "reaccion" || turn.kind === "apertura" || turn.kind === "cierre" || turn.kind === "transicion") ? "two_shot" : turn.speaker === "A" ? "avatar_a" : "avatar_b";
        shot = { kind, facing: turn.speaker, reason: kind === "two_shot" ? "Plano de conversación (two-shot) compuesto: los dos avatares en el set." : kind === "over_shoulder" ? "Sobre el hombro compuesto: habla quien mira a cámara." : "Primer plano de quien habla." };
      } else shot = { kind: turn.speaker === "A" ? "avatar_a" : "avatar_b", reason: "El avatar presenta este turno." };
      // Duración máxima por aparición: el resto del turno pasa a imagen relacionada (la voz sigue).
      if (capped < dur - 0.05) {
        shots.push({ turn_id: turn.id, speaker: turn.speaker, start, end: start + capped, ...shot });
        avatarSeconds[turn.speaker] += capped;
        if (shot.kind === "two_shot") avatarSeconds[turn.speaker === "A" ? "B" : "A"] += capped;
        const rest = visual() ?? { kind: "transicion" as const, reason: "Resto del turno sin imagen relacionada: transición." };
        shots.push({ turn_id: turn.id, speaker: turn.speaker, start: start + capped, end, ...rest, reason: `Límite de ${input.avatarMaxSeconds}s por aparición; ${rest.reason}` });
        lastKind = rest.kind; t = end; return;
      }
      avatarSeconds[turn.speaker] += dur;
      if (shot.kind === "two_shot") avatarSeconds[turn.speaker === "A" ? "B" : "A"] += dur;
    } else {
      shot = visual() ?? { kind: "transicion", reason: "Sin imagen relacionada sin repetir: transición (no se fuerza otra aparición de pago)." };
    }
    // Sin saltos incoherentes: dos primeros planos seguidos de hablantes distintos → el segundo pasa a sobre el hombro.
    if (input.mode === "dialogo" && input.hasAvatar.A && input.hasAvatar.B && (shot.kind === "avatar_a" || shot.kind === "avatar_b") && (lastKind === "avatar_a" || lastKind === "avatar_b") && lastKind !== shot.kind)
      shot = { ...shot, kind: "over_shoulder", facing: turn.speaker, reason: "Cambio de hablante encadenado: sobre el hombro para no saltar entre primeros planos." };
    shots.push({ turn_id: turn.id, speaker: turn.speaker, start, end, ...shot });
    lastKind = shot.kind; t = end;
    if (i === n - 1 && used.size === 0 && input.mode === "narracion" && input.assets.length > 0) issues.push("Ninguna imagen relacionada: revisa las búsquedas visuales.");
  });
  const ids = shots.filter((s) => s.asset_id).map((s) => s.asset_id!);
  if (new Set(ids).size !== ids.length) issues.push("Imagen repetida en el plan.");
  return { shots, issues, avatarSeconds, assetsUsed: ids };
}

/** Comprobaciones del plan (pruebas y QC): continuidad temporal, etiquetas de recreación, sin repeticiones. */
export function planIssues(plan: EditorialPlan): string[] {
  const out: string[] = [...plan.issues];
  for (let i = 1; i < plan.shots.length; i++) if (Math.abs(plan.shots[i].start - plan.shots[i - 1].end) > 1e-6) out.push(`Hueco/solape entre planos ${i - 1} y ${i}.`);
  for (const s of plan.shots) if (s.kind === "recreacion" && s.label !== "Recreación") out.push(`Recreación sin etiqueta en ${s.turn_id}.`);
  return out;
}
