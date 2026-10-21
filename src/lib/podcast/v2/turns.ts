/** Lógica de /api/podcast/[id]/turns separada de Next para probarla con manejadores reales y Storage simulado. */
import { RECORDING_MAX_BYTES, RECORDING_MIME, recordingUploadPath, isRecordingPathFor, sniffAudio } from "@/lib/podcast/recording";
import { PodcastProduction, attachRecording, estimateProduction, productionScript } from "./production";

export type TurnDeps = {
  userId: string; episode: { id: string; user_id: string; status: string; production?: unknown };
  body: Record<string, unknown> | null;
  signUpload: (path: string) => Promise<string | null>;
  download: (path: string) => Promise<Buffer | null>;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
};

export async function applyTurnAction(d: TurnDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  if (d.episode.user_id !== d.userId) return { status: 404, body: { error: "Episodio no encontrado." } };
  const parsed = PodcastProduction.safeParse(d.episode.production);
  if (!parsed.success) return { status: 409, body: { error: "Este episodio no tiene producción por turnos." } };
  if (d.episode.status === "generating") return { status: 409, body: { error: "Hay una generación en curso." } };
  const b = d.body ?? {};
  const turnId = typeof b.turnId === "string" ? b.turnId : "";
  if (b.action === "ticket") {
    if (!(RECORDING_MIME as readonly string[]).includes(String(b.mime ?? ""))) return { status: 400, body: { error: "Formato no admitido." } };
    if (!(Number(b.size) > 0) || Number(b.size) > RECORDING_MAX_BYTES) return { status: 400, body: { error: "Tamaño no admitido." } };
    const path = recordingUploadPath(d.userId, d.episode.id);
    const token = await d.signUpload(path);
    return token ? { status: 200, body: { path, token } } : { status: 500, body: { error: "No se pudo preparar la subida." } };
  }
  let next: PodcastProduction;
  if (b.action === "attach") {
    const path = typeof b.path === "string" ? b.path : "";
    if (!isRecordingPathFor(d.userId, d.episode.id, path)) return { status: 403, body: { error: "Archivo no autorizado." } };
    const bytes = await d.download(path);
    if (!bytes) return { status: 404, body: { error: "No se encontró la grabación subida." } };
    if (!sniffAudio(bytes)) return { status: 400, body: { error: "El archivo no es un audio válido." } };
    try { next = attachRecording(parsed.data, d.userId, d.episode.id, turnId, path); } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
  } else if (b.action === "edit") {
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!parsed.data.turns.some((t) => t.id === turnId)) return { status: 404, body: { error: "Turno no encontrado." } };
    const r = PodcastProduction.safeParse({ ...parsed.data, turns: parsed.data.turns.map((t) => (t.id === turnId ? { ...t, text } : t)) });
    if (!r.success) return { status: 400, body: { error: r.error.issues[0]?.message ?? "Texto inválido." } };
    next = r.data;
  } else return { status: 400, body: { error: "Acción inválida." } };
  const est = estimateProduction(next);
  const ok = await d.save({ production: next, script: productionScript(next), characters: est.characters, estimated_usd: est.usd, status: "draft", production_timeline: null, audio_path: null });
  return ok ? { status: 200, body: { ok: true, estimate: est } } : { status: 409, body: { error: "El episodio cambió; recarga la página." } };
}
