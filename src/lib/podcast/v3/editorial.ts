/**
 * Podcast 3.0 — planificador editorial DETERMINISTA (misma entrada → mismo plan, sin red).
 * Decide por turno qué se ve: avatar hablando, segundo participante, two-shot, sobre el hombro, imagen documental,
 * recreación (etiquetada «Recreación»), archivo o transición. Reglas:
 *  - VERACIDAD: una recreación nunca se presenta como evidencia; siempre lleva la etiqueta en pantalla.
 *  - Coherencia: la imagen de un turno se elige por palabras del propio turno (sin escenas ajenas al diálogo);
 *    nunca la misma imagen dos veces en el episodio salvo que la biblioteca se agote (se informa).
 *  - Continuidad: estudio compartido, A a la izquierda y B a la derecha en todos los planos; las apariciones del avatar
 *    respetan frecuencia y duración máxima (costo).
 */
import type { StudioMode } from "./spec";
import { estimateSeconds, type Turn } from "./script";

export type ShotKind = "avatar_a" | "avatar_b" | "two_shot" | "over_shoulder" | "imagen" | "recreacion" | "archivo" | "transicion" | "titulo" | "estudio_quieto";
export type VisualAsset = { id: string; query: string; kind: "foto" | "archivo" | "recreacion" | "ilustracion"; tags: string[]; credit?: string;
  /** Ilustración generada para UN turno concreto (Recraft): ese turno la usa antes que cualquier otra. */
  forTurn?: string };
export type Shot = {
  turn_id: string | null; speaker: "A" | "B" | null; kind: ShotKind; start: number; end: number;
  asset_id?: string; label?: "Recreación" | "Archivo" | "Ilustración"; reason: string;
  /** Alternativa explícita cuando la imagen del turno no superó la verificación: tarjeta con la idea del turno. */
  card?: string;
  /** En sobre el hombro: quién mira a cámara (habla) y quién queda de espaldas. */
  facing?: "A" | "B";
  /** En «estudio_quieto»: quiénes aparecen sentados (foto fija, sin labios ni costo de avatar). */
  people?: ("A" | "B")[];
};
export type PlanInput = {
  mode: StudioMode; turns: (Turn & { seconds?: number })[]; assets: VisualAsset[];
  avatarFrequency: number; avatarMaxSeconds: number; recreations: boolean; hasAvatar: { A: boolean; B: boolean };
  introSeconds?: number;
  /** Términos del tema: un turno sin imagen propia usa una imagen NO usada del tema antes que un plano vacío. */
  topicTerms?: string[];
};
export type EditorialPlan = { shots: Shot[]; issues: string[]; avatarSeconds: { A: number; B: number }; assetsUsed: string[] };

const STOP = new Set("de la el los las un una y o que en a por para con se su sus es son lo al del como más pero sus este esta eso esa muy ya no sí si le les me te nos hay fue era ser hace hoy aquí allí the of and to in is".split(" "));
export const keywords = (text: string) => [...new Set(text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9ñ]+/).filter((w) => w.length > 3 && !STOP.has(w)))];

/** Términos que anclan las búsquedas de imágenes al tema del episodio: los del tema si lo hay; si no, las palabras clave
 *  las del título (sin cifras ni fechas); si tampoco, las palabras clave repetidas del guion (empate → primera aparición). Sin ancla, una frase como «Va de salida» buscaba
 *  «salida» y traía un letrero de salida de un estacionamiento (prueba real 2026-10-28). */
export function salientTerms(topic: string, texts: string[], n = 2, title = ""): string[] {
  const words = (t: string) => keywords(t).filter((w) => !/^\d+$/.test(w));
  for (const head of [topic, title]) { const w = words(head); if (w.length) return w.slice(0, n); }
  const count = new Map<string, number>();
  for (const t of texts) for (const w of keywords(t)) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

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
  // Frecuencia: el avatar aparece en ~freq de los turnos DE CADA PARTICIPANTE, repartido de forma uniforme (un acumulador
  // determinista por hablante). Con un único acumulador, una conversación que alterna A/B con freq 0.5 daba TODAS las
  // apariciones al mismo hablante (prueba real 2026-10-28, episodio 0a482791: Valeria nunca habló a cámara).
  // Arranca de modo que el primer turno de cada uno lo presente su avatar.
  const acc = { A: 1 - input.avatarFrequency, B: 1 - input.avatarFrequency };
  // Turno sin avatar ni imagen (p. ej. «Solo estudio y anfitriones»): los anfitriones siguen sentados en el estudio en
  // un plano fijo (foto, sin labios ni costo de avatar). Antes quedaba el estudio VACÍO (prueba real 2026-10-31,
  // episodio ba27b6f7: ~25 de 54 s sin nadie en pantalla).
  const seated = (["A", "B"] as const).filter((x) => input.hasAvatar[x]);
  const still = (why: string) => input.mode !== "narracion" && seated.length
    ? { kind: "estudio_quieto" as const, people: [...seated], reason: `${why}: los anfitriones en el estudio (plano fijo, sin costo de avatar).` }
    : { kind: "transicion" as const, reason: `${why}: transición.` };
  input.turns.forEach((turn, i) => {
    const dur = turn.seconds ?? estimateSeconds(turn.text);
    const start = t, end = t + dur;
    acc[turn.speaker] += input.avatarFrequency;
    // Frecuencia 0 = sin avatar (el acumulador arranca en 1 y daba igualmente el primer turno).
    const wantsAvatar = input.mode !== "narracion" && input.avatarFrequency > 0 && acc[turn.speaker] >= 1 - 1e-9 && input.hasAvatar[turn.speaker];
    if (wantsAvatar) acc[turn.speaker] -= 1;
    const visual = () => {
      // Ilustración propia del turno (Recraft): describe ESTA intervención; nunca se reparte entre turnos.
      const own = input.assets.find((a) => a.forTurn === turn.id && !used.has(a.id));
      if (own) { used.add(own.id); return { kind: "imagen" as const, asset_id: own.id, reason: "Ilustración generada para el contenido de este turno." }; }
      const pick = pickAsset(turn.text, input.assets.filter((a) => !a.forTurn), used, input.recreations);
      if (pick) {
        used.add(pick.asset.id);
        const kind: ShotKind = pick.asset.kind === "recreacion" ? "recreacion" : pick.asset.kind === "archivo" ? "archivo" : "imagen";
        return { kind, asset_id: pick.asset.id, ...(kind === "recreacion" ? { label: "Recreación" as const } : kind === "archivo" ? { label: "Archivo" as const } : {}), reason: `Imagen relacionada con el turno (${pick.score.toFixed(0)} coincidencias).` };
      }
      // Sin imagen propia del turno: una imagen del TEMA aún no usada (encontrada por la búsqueda del tema), nunca una
      // ajena. Solo si tampoco la hay, el plano queda en transición.
      const topic = new Set((input.topicTerms ?? []).map((w) => w.toLowerCase()));
      const onTopic = topic.size === 0 ? undefined : input.assets
        .filter((a) => a.kind !== "recreacion" && !a.forTurn && !used.has(a.id) && a.tags.some((tag) => topic.has(tag.toLowerCase())))
        .sort((x, y) => x.id.localeCompare(y.id))[0];
      if (onTopic) {
        used.add(onTopic.id);
        const kind: ShotKind = onTopic.kind === "archivo" ? "archivo" : "imagen";
        return { kind, asset_id: onTopic.id, ...(kind === "archivo" ? { label: "Archivo" as const } : {}), reason: "Imagen del tema del episodio (el turno no tiene imagen propia)." };
      }
      return null;
    };
    let shot: Omit<Shot, "turn_id" | "speaker" | "start" | "end">;
    if (input.mode === "narracion") {
      shot = visual() ?? { kind: "transicion", reason: "Sin imagen relacionada sin repetir: se usa un plano de transición (no una imagen ajena)." };
    } else if (wantsAvatar) {
      const capped = Math.min(dur, input.avatarMaxSeconds);
      if (input.mode === "dialogo" && input.hasAvatar.A && input.hasAvatar.B) {
        // Estudio compartido (2026-10-28): plano general de los dos sentados a la mesa para abrir, cerrar, cambiar de bloque,
        // reaccionar o discrepar; el resto, primer plano de quien habla en su asiento (misma posición que en el general).
        // El «sobre el hombro» (oyente oscuro y desenfocado encima del otro) se retiró: parecía dos retratos superpuestos.
        const kind: ShotKind = (turn.kind === "reaccion" || turn.kind === "apertura" || turn.kind === "cierre" || turn.kind === "transicion" || turn.kind === "desacuerdo") ? "two_shot" : turn.speaker === "A" ? "avatar_a" : "avatar_b";
        shot = { kind, facing: turn.speaker, reason: kind === "two_shot" ? "Plano general: los dos en el mismo estudio, a cada lado de la mesa." : "Primer plano de quien habla, en su asiento." };
      } else shot = { kind: turn.speaker === "A" ? "avatar_a" : "avatar_b", reason: "El avatar presenta este turno." };
      // Duración máxima por aparición: el resto del turno pasa a imagen relacionada (la voz sigue).
      if (capped < dur - 0.05) {
        shots.push({ turn_id: turn.id, speaker: turn.speaker, start, end: start + capped, ...shot });
        avatarSeconds[turn.speaker] += capped;
        if (shot.kind === "two_shot") avatarSeconds[turn.speaker === "A" ? "B" : "A"] += capped;
        const rest = visual() ?? still("Resto del turno sin imagen relacionada");
        shots.push({ turn_id: turn.id, speaker: turn.speaker, start: start + capped, end, ...rest, reason: `Límite de ${input.avatarMaxSeconds}s por aparición; ${rest.reason}` });
        t = end; return;
      }
      avatarSeconds[turn.speaker] += dur;
      if (shot.kind === "two_shot") avatarSeconds[turn.speaker === "A" ? "B" : "A"] += dur;
    } else {
      shot = visual() ?? still("Sin imagen relacionada sin repetir (no se fuerza otra aparición de pago)");
    }
    // Plano/contraplano: A siempre a la izquierda y B a la derecha (también en los primeros planos), así que dos primeros
    // planos seguidos de hablantes distintos mantienen la continuidad de posiciones y no necesitan un plano intermedio.
    shots.push({ turn_id: turn.id, speaker: turn.speaker, start, end, ...shot });
    t = end;
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

/** Pistas de que un texto habla del pasado (su ilustración es una reconstrucción → «Recreación»). */
export const PAST_RE = /\b(antigu|histori|siglo|milenio|civilizaci|imperio|mesopotam|sumer|babilon|asiri|egipci|fara[oó]n|roman|griego|maya|azteca|inca|medieval|prehist|tablilla|cuneiform|arqueol|ruina|templo|zigurat)/i;
/**
 * Época visual del episodio. Episodio real 51883d1c («Vida después de la visa»): 27 ilustraciones de ruinas y arcos,
 * porque todo episodio se ilustraba como documental histórico (referencias de estilo de un zigurat y un museo, y una lista
 * negativa que prohibía aviones, coches y teléfonos). «historica» solo si el tema, o al menos un tercio de los turnos,
 * habla del pasado; si no, «actual».
 */
export function topicEra(topic: string, texts: string[]): "historica" | "actual" {
  if (PAST_RE.test(topic)) return "historica";
  return texts.length && texts.filter((t) => PAST_RE.test(t)).length * 3 >= texts.length ? "historica" : "actual";
}
/** Encuadres que se alternan turno a turno: dos ilustraciones seguidas nunca comparten composición. */
export const SHOT_VARIETY = [
  "wide establishing shot",
  "medium shot of people in a candid everyday moment",
  "close-up of a meaningful object, shallow depth of field",
  "over-the-shoulder view of a person doing an everyday task",
  "street-level scene with depth and movement",
  "interior scene with warm window light",
  "symbolic still life on a table",
  "high-angle view of the place",
] as const;
/** Lista negativa de un episodio de actualidad: lo antiguo no aparece y lo moderno (aviones, teléfonos…) sí puede. */
export const NEGATIVE_ACTUAL = "text, letters, captions, watermarks, logos, ancient ruins, pyramids, ziggurats, stone arches, temples, museum display cases, archaeological artifacts, holiday decorations, clothing catalog, product photos";

